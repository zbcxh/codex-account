"""功能：验证常驻可靠上报、退避与单例。参数：隔离构建目录。返回：合成测试结果，不访问真实任务、账号或数据库。"""
import argparse
import hashlib
import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import ctypes
from ctypes import wintypes

parser = argparse.ArgumentParser()
parser.add_argument('--build', required=True, type=pathlib.Path)
args = parser.parse_args()
build = args.build.resolve()
reports, acknowledgements = [], []


class Handler(http.server.BaseHTTPRequestHandler):
    """功能：提供仅回环的合成上报端点。参数：HTTP 请求。返回：测试配置及确认。"""

    def log_message(self, *_):
        """功能：避免日志记录合成令牌。参数：标准日志字段。返回：无。"""

    def do_POST(self):
        """功能：记录合成上报并下发二十分钟周期。参数：无。返回：HTTP JSON。"""
        assert self.headers.get('x-quota-token') == 'fixture-token'
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/api/report':
            reports.append(body)
            response = {'ok': True, 'reporting_config': {'version': 2, 'interval_minutes': 20,
                        'applied_version': 2 if acknowledgements else 1,
                        'applied_interval_minutes': 20 if acknowledgements else 5}}
        else:
            assert self.path == '/api/client/reporting-ack'
            acknowledgements.append(body)
            response = {'ok': True}
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())


def run(*command, env=None):
    """功能：运行隔离子进程。参数：命令和合成环境。返回：JSON 结果；异常直接失败。"""
    result = subprocess.run([str(x) for x in command], capture_output=True, timeout=35, env=env)
    assert result.returncode == 0, (result.stdout, result.stderr)
    return json.loads(result.stdout)


with tempfile.TemporaryDirectory(prefix='quota-resident-fixture-') as directory:
    temp = pathlib.Path(directory)
    root = temp/'state'
    run(build/'QuotaClientTestDriver.exe', 'seed', root)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        config = {'client_id': 'fixture-client', 'task_name': 'FixtureTask',
                  'server_url': f'http://127.0.0.1:{server.server_port}',
                  'reporting_config_version': 1, 'reporting_interval_minutes': 5,
                  'unknown': {'keep': 'unchanged'}}
        (root/'config.json').write_text(json.dumps(config), encoding='utf-8')
        tokens = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.glob('token*.bin')}
        audit = temp/'initializations.txt'
        env = dict(os.environ, RESIDENT_FIXTURE_AUDIT=str(audit))
        busy = run(build/'ResidentTests.exe', 'locked', root, env=env)
        assert busy['skipped'] == 'collector_busy' and busy['created'] == 0
        result = run(build/'ResidentTests.exe', 'loop', root, env=env)
        assert result['samples'] == 3 and result['created'] == 1
        assert result['waits'] == [1200000, 1200000]
        assert audit.read_text().splitlines() == ['initialize']
        assert [r['reporting_status']['interval_minutes'] for r in reports] == [5, 20, 20]
        assert acknowledgements == [{'version': 2, 'interval_minutes': 20}]
        saved = json.loads((root/'config.json').read_text())
        assert saved['client_id'] == config['client_id'] and saved['unknown'] == config['unknown']
        assert saved['server_url'] == config['server_url'] and saved['reporting_interval_minutes'] == 20
        assert tokens == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.glob('token*.bin')}
        retry = run(build/'ResidentTests.exe', 'backoff', root, env=env)
        assert retry['exit_code'] == 2 and retry['created'] == 3
        assert retry['waits'] == [300000, 900000, 1800000]
        paused = run(build/'ResidentTests.exe', 'loop', root, env=env)
        assert paused['error'] == 'resident_paused' and paused['created'] == 0
        resumed = run(build/'ResidentTests.exe', 'loop', root, 'resume', env=env)
        assert resumed['samples'] == 3 and not (root/'resident.paused.json').exists()
        unstable = run(build/'ResidentTests.exe', 'early-fault', root, env=env)
        assert unstable['exit_code'] == 2 and unstable['created'] == 3
        assert unstable['waits'] == [1200000, 300000, 1200000, 900000, 1200000, 1800000]
        run(build/'ResidentTests.exe', 'loop', root, 'resume', env=env)
        cleanup = run(build/'ResidentTests.exe', 'cleanup', root, env=env)
        assert cleanup['exit_code'] == 2 and cleanup['created'] == 1
        assert cleanup['waits'] == [1200000, 1200000]
        print(json.dumps({'ok': True, 'checks': ['singleton', 'one_initialize_three_reports',
                         'internal_timer_ack', 'identity_token_config_preserved',
                         'bounded_backoff_and_persisted_pause', 'explicit_resume',
                         'short_success_does_not_reset_failures', 'uncertain_cleanup_never_restarts']}, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

    # 强制关闭合成控制进程，验证内核关句柄回收后代；独立对照进程必须保留。
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    unrelated = subprocess.Popen([str(build/'ResidentTests.exe'), 'fixture-child'], creationflags=subprocess.CREATE_NO_WINDOW)
    parent = subprocess.Popen([str(build/'ResidentTests.exe'), 'crash-parent', str(temp/'child.pid')],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
    child_handle = None
    try:
        pid_line = parent.stdout.readline()
        assert pid_line, parent.stderr.read()
        child_handle = kernel.OpenProcess(0x100000, False, int(pid_line))
        assert child_handle
        parent.kill()
        parent.wait(timeout=10)
        assert kernel.WaitForSingleObject(child_handle, 5000) == 0
        assert unrelated.poll() is None
        print(json.dumps({'ok': True, 'crashed_parent_tree_reclaimed': True, 'unrelated_process_preserved': True}))
    finally:
        if child_handle:
            kernel.CloseHandle(child_handle)
        if parent.poll() is None:
            parent.kill()
        parent.wait(timeout=10)
        unrelated.terminate()
        unrelated.wait(timeout=10)
