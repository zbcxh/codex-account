import argparse
import hashlib
import http.server
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).parent
parser = argparse.ArgumentParser()
parser.add_argument('--driver', type=pathlib.Path, default=ROOT/'bin/QuotaClientTestDriver.exe')
parser.add_argument('--client', type=pathlib.Path, default=ROOT/'bin/CodexQuotaCollector.exe')
options = parser.parse_args()
DRIVER = options.driver.resolve()
CLIENT = options.client.resolve()
CSC = pathlib.Path(os.environ['WINDIR'])/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
checks = []


def execute(exe, *args, expected=0):
    """功能：运行隔离测试进程并解析 JSON。参数：程序、参数和预期退出码。返回：JSON 状态。"""
    result = subprocess.run([str(exe), *map(str, args)], capture_output=True, timeout=35)
    assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
    return json.loads((result.stdout or result.stderr).decode('utf-8-sig'))


def hashes(root, names):
    """功能：计算合成保护文件指纹。参数：目录与文件名。返回：指纹字典。"""
    return {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in names if (root/name).is_file()}


class Handler(http.server.BaseHTTPRequestHandler):
    """功能：模拟现有上报与确认接口。参数：HTTP 请求。返回：可注入故障的合成响应。"""
    reports = []
    acknowledgements = []
    mode = 'ok'
    desired = {'version': 1, 'interval_minutes': 5, 'applied_version': 1, 'applied_interval_minutes': 5}
    historical_desired = None

    def log_message(self, *args):
        """功能：抑制测试服务日志。参数：标准日志参数。返回：无。"""
        pass

    def do_POST(self):
        """功能：捕获合成请求并返回既有协议。参数：无。返回：HTTP 确认。"""
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.headers['x-quota-token'] == 'fixture-token'
        if self.path == '/api/client/reporting-ack':
            self.acknowledgements.append(body)
        else:
            assert self.path == '/api/report'
            assert body['source'] == 'app_server'
            assert 'timing' not in body
            self.reports.append(body)
        if self.mode == 'disconnect':
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        status = int(self.mode) if self.mode.isdigit() else 200
        if self.mode == 'redirect':
            self.send_response(307)
            self.send_header('Location', 'https://never-contact.example.invalid/api/report')
            self.end_headers()
            return
        # 历史响应故意返回不同周期，确保满队列恢复不会把补传响应当成本轮配置。
        desired = self.historical_desired if body.get('collected_at') == 1 and self.historical_desired is not None else self.desired
        response = json.dumps({'ok': status == 200, 'reporting_config': desired}).encode()
        if self.mode == 'oversize':
            response = b' ' * 66000 + response
        self.send_response(status)
        self.send_header('Content-Length', str(len(response)))
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(response)


with tempfile.TemporaryDirectory(prefix='quota-compiled-client-fixture-') as temporary:
    temp = pathlib.Path(temporary).resolve()
    # 直接复用当前采集器的合成 RPC 夹具，不再依赖已退役的 PowerShell 实现。
    fake = (ROOT/'tests/FakeAppServer.cs').read_text(encoding='utf-8-sig')
    fake_source, fake_exe = temp/'Fake.cs', temp/'fake-codex.exe'
    fake_source.write_text(fake, encoding='utf-8-sig')
    subprocess.run([str(CSC), '/nologo', '/optimize+', '/target:exe', f'/out:{fake_exe}', str(fake_source)], capture_output=True, check=True)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'

    def seed(name):
        """功能：创建私有合成监控目录。参数：目录名。返回：新状态目录。"""
        root = temp/name
        execute(DRIVER, 'seed', root)
        (root/'config.json').write_text(json.dumps({'client_id': 'fixture-client', 'server_url': base, 'task_name': 'FixtureTask', 'reporting_config_version': 1, 'reporting_interval_minutes': 5, 'unknown': {'keep': 'value'}}), encoding='utf-8')
        (root/'state.json').write_text('{"legacy_cache":"keep exactly"}', encoding='utf-8')
        return root

    try:
        root = seed('success')
        protected = hashes(root, ['config.json', 'token.bin', 'token.lm.bin', 'state.json'])
        result = execute(DRIVER, 'run', root, base, fake_exe)
        assert result['sent_report'] and result['account_verified']
        assert not list((root/'spool').glob('*.json'))
        assert hashes(root, protected) == protected
        checks.append('Successful report preserves config/token/cache bytes; confirmed event removed')

        before = len(Handler.reports)
        assert execute(DRIVER, 'busy', root, base, fake_exe)['skipped'] == 'collector_busy'
        assert len(Handler.reports) == before
        checks.append('Shared file lock prevents overlap before collection or upload')

        absent = temp/'must-not-exist'
        before = len(Handler.reports)
        assert execute(DRIVER, 'dry', absent, base, fake_exe)['sent_report'] is False
        assert not absent.exists() and len(Handler.reports) == before
        checks.append('DryRun creates no directory and sends no report')

        root = seed('cu-fallback')
        (root/'token.lm.bin').write_bytes(b'invalid machine blob')
        before = hashes(root, ['token.bin', 'token.lm.bin'])
        execute(DRIVER, 'token', root)
        assert hashes(root, before) == before
        checks.append('DPAPI CurrentUser fallback works without rewriting either token blob')

        root = seed('network-failure')
        protected = hashes(root, ['config.json', 'token.bin', 'token.lm.bin', 'state.json'])
        Handler.mode = 'disconnect'
        execute(DRIVER, 'run', root, base, fake_exe)
        queued = list((root/'spool').glob('*.json'))
        assert len(queued) == 1
        old = json.loads(queued[0].read_text())
        assert queued[0].stem == old['event_id']
        assert hashes(root, protected) == protected
        Handler.mode = 'ok'
        time.sleep(1.1)
        before = len(Handler.reports)
        execute(DRIVER, 'run', root, base, fake_exe)
        sent = Handler.reports[before:]
        assert len(sent) == 2 and sent[-1]['event_id'] == old['event_id']
        assert sent[0]['collected_at'] >= sent[-1]['collected_at']
        assert not list((root/'spool').glob('*.json'))
        checks.append('Interrupted upload retains durable event; next run sends current identity before one stable-ID retry')

        root = seed('unauthorized')
        protected = hashes(root, ['config.json', 'token.bin', 'token.lm.bin', 'state.json'])
        Handler.mode = '401'
        assert execute(DRIVER, 'run', root, base, fake_exe, expected=1)['queued']
        assert len(list((root/'spool').glob('*.json'))) == 1 and hashes(root, protected) == protected
        checks.append('Authentication failure preserves event, credentials and configuration')
        Handler.mode = 'ok'

        root = seed('legacy')
        (root/'spool').mkdir()
        (root/'spool/legacy.json').write_text('{"source":"session_tail","account_id":"old"}')
        (root/'spool/corrupt.json').write_bytes(b'not-json\xff')
        previous = hashes(root/'spool', ['legacy.json', 'corrupt.json'])
        execute(DRIVER, 'run', root, base, fake_exe)
        assert hashes(root/'spool-unverified', previous) == previous
        checks.append('Legacy and unreadable queues isolated byte-for-byte without replay')

        root = seed('full')
        (root/'spool').mkdir()
        for n in range(72):
            (root/f'spool/{n:064x}.json').write_text(json.dumps({'source': 'app_server', 'event_id': f'{n:064x}'}))
        previous = hashes(root/'spool', [p.name for p in (root/'spool').glob('*.json')])
        before = len(Handler.reports)
        execute(DRIVER, 'run', root, base, fake_exe, expected=1)
        assert len(Handler.reports) == before and hashes(root/'spool', previous) == previous
        checks.append('Full queue refuses new work without eviction or upload')

        root = seed('full-recovery')
        (root/'spool').mkdir()
        # 使用完整可信报告填满队列；不以缺少身份的畸形文件代替可恢复的网络积压。
        for n in range(72):
            queued_report = dict(old, event_id=f'{n:064x}', collected_at=1)
            (root/f'spool/{n:064x}.json').write_text(json.dumps(queued_report))
        protected = hashes(root, ['config.json', 'token.bin', 'token.lm.bin', 'state.json'])
        previous = hashes(root/'spool', [p.name for p in (root/'spool').glob('*.json')])
        Handler.historical_desired = {'version': 999, 'interval_minutes': 77, 'applied_version': 0, 'applied_interval_minutes': 5}
        before = len(Handler.reports)
        assert execute(DRIVER, 'run', root, base, fake_exe)['sent_report']
        sent = Handler.reports[before:]
        assert len(sent) == 2 and sent[0]['collected_at'] == 1 and sent[1]['collected_at'] > 1
        remaining = hashes(root/'spool', list(previous))
        assert len(remaining) == 71 and all(previous[name] == digest for name, digest in remaining.items())
        assert len(list((root/'spool').glob('*.json'))) == 71 and hashes(root, protected) == protected
        assert not (root/'fixture-task.txt').exists()
        checks.append('Full verified queue frees one acknowledged slot, sends current report, preserves all other events and ignores historical configuration')
        Handler.historical_desired = None

        # 两类失败均保留满队列字节，不丢弃旧事件，也不绕过可靠入队发送新报告。
        for failure in ['disconnect', '401']:
            root = seed('full-recovery-'+failure)
            (root/'spool').mkdir()
            for n in range(72):
                queued_report = dict(old, event_id=f'{n:064x}', collected_at=1)
                (root/f'spool/{n:064x}.json').write_text(json.dumps(queued_report))
            previous = hashes(root/'spool', [p.name for p in (root/'spool').glob('*.json')])
            protected = hashes(root, ['config.json', 'token.bin', 'token.lm.bin', 'state.json'])
            Handler.mode = failure
            before = len(Handler.reports)
            execute(DRIVER, 'run', root, base, fake_exe, expected=1)
            assert len(Handler.reports)-before == 1 and Handler.reports[-1]['collected_at'] == 1
            assert hashes(root/'spool', previous) == previous and hashes(root, protected) == protected
            Handler.mode = 'ok'
            assert execute(DRIVER, 'run', root, base, fake_exe)['sent_report']
            assert len(list((root/'spool').glob('*.json'))) == 71
            checks.append('Full queue preserves every event on '+failure+' and recovers on the next successful run')

        root = seed('full-identity-gate')
        (root/'spool').mkdir()
        for n in range(72):
            queued_report = dict(old, event_id=f'{n:064x}', collected_at=1)
            (root/f'spool/{n:064x}.json').write_text(json.dumps(queued_report))
        previous = hashes(root/'spool', [p.name for p in (root/'spool').glob('*.json')])
        before = len(Handler.reports)
        assert execute(DRIVER, 'dry', root, base, fake_exe)['sent_report'] is False
        assert len(Handler.reports) == before and hashes(root/'spool', previous) == previous
        # 只改合成额度响应中的账号，让前后身份与额度归属不一致；不能因此提前补传满队列。
        bad_source, bad_exe = temp/'FakeMismatch.cs', temp/'fake-mismatch.exe'
        bad_source.write_text(fake.replace('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 1), encoding='utf-8-sig')
        subprocess.run([str(CSC), '/nologo', '/optimize+', '/target:exe', f'/out:{bad_exe}', str(bad_source)], capture_output=True, check=True)
        execute(DRIVER, 'run', root, base, bad_exe, expected=1)
        assert len(Handler.reports) == before and hashes(root/'spool', previous) == previous
        checks.append('Full queue cannot trigger uploads in DryRun or before current account ownership verification')

        root = seed('queue-failure')
        (root/'spool').write_text('must preserve this unexpected file')
        before = len(Handler.reports)
        execute(DRIVER, 'run', root, base, fake_exe, expected=1)
        assert len(Handler.reports) == before and (root/'spool').read_text() == 'must preserve this unexpected file'
        checks.append('Queue write failure prevents upload and preserves unexpected files')

        root = seed('interval')
        protected = hashes(root, ['token.bin', 'token.lm.bin', 'state.json'])
        Handler.desired = {'version': 2, 'interval_minutes': 10, 'applied_version': 0, 'applied_interval_minutes': 5}
        execute(DRIVER, 'run', root, base, fake_exe)
        cfg = json.loads((root/'config.json').read_text())
        assert cfg['unknown'] == {'keep': 'value'} and cfg['client_id'] == 'fixture-client'
        assert cfg['reporting_interval_minutes'] == 10 and cfg['reporting_config_version'] == 2
        assert (root/'fixture-task.txt').read_text() == '10'
        assert Handler.acknowledgements[-1] == {'version': 2, 'interval_minutes': 10}
        assert hashes(root, protected) == protected
        checks.append('Server interval applied and read back; unknown config, identity and tokens preserved')

        Handler.desired.update(applied_version=2, applied_interval_minutes=10)
        config_hash = hashes(root, ['config.json'])
        before_ack = len(Handler.acknowledgements)
        execute(DRIVER, 'run', root, base, fake_exe)
        assert hashes(root, config_hash) == config_hash and len(Handler.acknowledgements) == before_ack
        checks.append('Unchanged acknowledged interval causes no config rewrite or redundant acknowledgement')

        (root/'deny-task-update').touch()
        Handler.desired = {'version': 3, 'interval_minutes': 20, 'applied_version': 2, 'applied_interval_minutes': 10}
        execute(DRIVER, 'run', root, base, fake_exe)
        assert hashes(root, config_hash) == config_hash
        assert Handler.acknowledgements[-1] == {'version': 3, 'interval_minutes': 10, 'error': 'schedule_update_failed'}
        checks.append('Permission failure acknowledges actual interval and never claims desired configuration applied')

        for bad in [0, 1441, 1.5, True, '10']:
            desired = {'version': 3, 'interval_minutes': bad}
            execute(DRIVER, 'apply', root, json.dumps(desired), expected=1)
            assert hashes(root, config_hash) == config_hash
        checks.append('Invalid interval types and bounds rejected before task/config writes')

        Handler.desired = {'version': 1, 'interval_minutes': 5, 'applied_version': 1, 'applied_interval_minutes': 5}
        root = seed('redirect')
        Handler.mode = 'redirect'
        execute(DRIVER, 'run', root, base, fake_exe)
        assert len(list((root/'spool').glob('*.json'))) == 1
        checks.append('HTTP redirect does not forward token; event retained')
        Handler.mode = 'oversize'
        execute(DRIVER, 'run', root, base, fake_exe, expected=1)
        assert list((root/'spool').glob('*.json'))
        checks.append('Oversize response fails with durable event retained')
        Handler.mode = 'ok'

        root = seed('formal-entry')
        result = execute(CLIENT, '--run', '--state-dir', root, '--server', base, '--codex', fake_exe)
        assert result['sent_report']
        assert 'timing' not in result
        assert not (root/'logs/performance.jsonl').exists()
        ordinary_log = (root/'logs/report.log').read_text(encoding='utf-8')
        assert 'report_ok_account_' in ordinary_log
        assert 'fixture-token' not in ordinary_log
        # 已有性能历史属于用户文件；正式运行不得继续追加，也不得为清理埋点而删除它。
        historical_performance = root/'logs/performance.jsonl'
        historical_performance.write_bytes(b'preserve historical diagnostics\n')
        before_performance = historical_performance.read_bytes()
        repeated = execute(CLIENT, '--run', '--state-dir', root, '--server', base, '--codex', fake_exe)
        assert 'timing' not in repeated
        assert historical_performance.read_bytes() == before_performance
        checks.append('No stage timing output or performance writes; ordinary logs and historical files preserved')
        checks.append('Formal executable works with existing encrypted token format and HTTP API')

        execute(CLIENT, '--fixture-cert', 'anything', expected=1)
        execute(CLIENT, '--run', '--dry-run', expected=1)
        execute(CLIENT, expected=1)
        checks.append('Formal executable requires explicit mode and exposes no certificate-bypass fixture flags')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

report = {'passed': len(checks), 'checks': checks}
print(json.dumps(report, indent=2))
