"""隔离验证服务端周期配置、鉴权、确认与在线阈值，不访问实际部署数据。"""
import argparse
from contextlib import closing
import json
import socket
import sqlite3
import subprocess
import tempfile
import time
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument('--node', default='node')
args = parser.parse_args()
sys.stdout.reconfigure(encoding='utf-8')
root = Path(__file__).resolve().parents[1]
passed = 0


def check(label, ok):
    """功能：验证断言并计数；参数：说明与条件；返回：无，失败时中止。"""
    global passed
    assert ok, label
    passed += 1
    print('PASS', label, flush=True)


with tempfile.TemporaryDirectory(prefix='quota-reporting-config-') as directory:
    folder = Path(directory)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    dbpath = folder / 'test.sqlite3'
    proc = subprocess.Popen([args.node, '--no-warnings', str(root / 'server/server.mjs'), '--port', str(port),
                             '--db', str(dbpath), '--bootstrap', 'reporting-fixture'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def api(path, body=None, token=None, admin=False, expected=200, pairing_code=None):
        """功能：调用临时服务并校验状态；参数：路径、请求体、令牌、管理员标记、预期状态和合成配对码；返回：JSON。"""
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['x-quota-token'] = token
        if admin:
            headers['x-quota-bootstrap'] = 'reporting-fixture'
        if pairing_code:
            headers['x-quota-bootstrap'] = pairing_code
        request = Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            with urlopen(request, timeout=5) as response:
                code, value = response.status, json.load(response)
        except HTTPError as error:
            code, value = error.code, json.load(error)
        assert code == expected, (path, code, expected, value)
        return value

    def state(mid):
        """功能：读取临时设备状态；参数：设备编号；返回：设备面板对象。"""
        return next(machine for machine in api('/api/state')['machines'] if machine['machine_id'] == mid)

    try:
        for _ in range(100):
            try:
                api('/api/state')
                break
            except OSError:
                if proc.poll() is not None:
                    raise RuntimeError('临时服务启动失败')
                time.sleep(.1)
        # 当前协议将管理员口令与设备配对码分离，临时设备也必须通过真实配对码流程接入。
        pairing_code = api('/api/pairing-codes', {'name': '周期隔离测试', 'kind': 'permanent'}, admin=True)['code']
        a = api('/api/pair', {'client_id': 'interval-a'}, pairing_code=pairing_code)
        b = api('/api/pair', {'client_id': 'interval-b'}, pairing_code=pairing_code)
        aid, bid = a['machine_id'], b['machine_id']
        policy = api('/api/state')['reporting_config']
        check('默认五分钟，旧客户端实际窗口包含两分钟宽限', policy['default_interval_minutes'] == 5 and state(aid)['online_window_sec'] == 420)
        api('/api/reporting-config', {'interval_minutes': 10}, expected=403)
        api('/api/client/reporting-ack', {'version': 1, 'interval_minutes': 5}, token='wrong', expected=401)
        for invalid in [0, 1441, 1.5, True, '10', None, [], {}]:
            api('/api/reporting-config', {'interval_minutes': invalid}, admin=True, expected=400)
        check('配置写入鉴权及整数边界校验', api('/api/state')['reporting_config'] == policy)
        api('/api/machine/99999/reporting-config', {'interval_minutes': 10}, admin=True, expected=404)
        api('/api/reporting-config', {'interval_minutes': 20}, admin=True)
        version = api('/api/state')['reporting_config']['version']
        api('/api/reporting-config', {'interval_minutes': 20}, admin=True)
        check('幂等保存不增加版本，期望值不假装设备已经应用', api('/api/state')['reporting_config']['version'] == version and state(aid)['reporting']['applied_interval_minutes'] == 5)
        api(f'/api/machine/{aid}/reporting-config', {'interval_minutes': 10}, admin=True)
        check('单台覆盖不影响另一台目标值', state(aid)['reporting']['desired_interval_minutes'] == 10 and state(bid)['reporting']['desired_interval_minutes'] == 20)
        now = int(time.time())
        body = {'account_id': 'verified-account', 'collected_at': now, 'event_id': 'a' * 64, 'source': 'app_server',
                'primary': {'used_percent': 30, 'window_minutes': 300}, 'reporting_status': {'version': 0, 'interval_minutes': 5}}
        response = api('/api/report', body, token=a['token'])
        config = response['reporting_config']
        check('上报响应携带当前设备目标及版本', config['interval_minutes'] == 10 and config['version'] >= 2)
        with closing(sqlite3.connect(dbpath)) as db:
            db.execute('UPDATE machine SET last_ok_at=? WHERE machine_id=?', (now - 480, aid))
            db.commit()
            snapshots_before = db.execute('SELECT COUNT(*) FROM quota_snapshot').fetchone()[0]
        check('未确认前仍按实际五分钟离线', state(aid)['stale'] == 'grey' and state(aid)['reporting']['pending'])
        api('/api/client/reporting-ack', {'version': config['version'], 'interval_minutes': 10}, token=a['token'])
        updated = state(aid)
        with closing(sqlite3.connect(dbpath)) as db:
            snapshots_after = db.execute('SELECT COUNT(*) FROM quota_snapshot').fetchone()[0]
        check('确认十分钟后按实际周期加宽限判断，确认不冒充上报心跳', updated['stale'] == 'green' and updated['online_window_sec'] == 720 and updated['last_ok_at'] == now - 480 and snapshots_before == snapshots_after)
        replay = api('/api/report', body, token=a['token'])
        check('额度重放仍下发配置且不倒退实际周期', replay['replay'] and replay['reporting_config']['applied_interval_minutes'] == 10)
        api('/api/client/reporting-ack', {'version': config['version'] - 1, 'interval_minutes': 5}, token=a['token'], expected=409)
        api(f'/api/machine/{aid}/reporting-config', {'interval_minutes': 15}, admin=True)
        failed_config = state(aid)['reporting']
        api('/api/client/reporting-ack', {'version': failed_config['version'], 'interval_minutes': 10, 'error': 'schedule_update_failed'}, token=a['token'])
        failed = state(aid)['reporting']
        check('任务应用失败保留实际周期并显示待重试', failed['applied_interval_minutes'] == 10 and failed['desired_interval_minutes'] == 15 and failed['pending'] and failed['apply_error'])
        api('/api/client/reporting-ack', {'version': failed['version'], 'interval_minutes': 15}, token=a['token'])
        check('成功重试清除错误并确认新周期', not state(aid)['reporting']['pending'] and state(aid)['online_window_sec'] == 1020)
        before_a = state(aid)['reporting']
        current_b = state(bid)['reporting']
        api('/api/client/reporting-ack', {'machine_id': aid, 'version': current_b['version'], 'interval_minutes': 20}, token=b['token'])
        check('确认仅作用于配对令牌所属设备', state(aid)['reporting'] == before_a and state(bid)['online_window_sec'] == 1320)
        api(f'/api/machine/{aid}/reporting-config', {'interval_minutes': None}, admin=True)
        check('设备恢复继承，尚未确认前不改实际窗口', state(aid)['reporting']['desired_interval_minutes'] == 20 and state(aid)['online_window_sec'] == 1020)
        api('/api/reporting-config', {'interval_minutes': 8}, admin=True)
        check('继承设备跟随默认，实际窗口分别保持确认值', state(aid)['reporting']['desired_interval_minutes'] == 8 and state(bid)['reporting']['desired_interval_minutes'] == 8 and state(aid)['online_window_sec'] == 1020 and state(bid)['online_window_sec'] == 1320)
        with closing(sqlite3.connect(dbpath)) as db:
            db.execute('UPDATE machine SET last_ok_at=? WHERE machine_id=?', (now - 1021, aid))
            db.commit()
        check('超过实际周期后下线', state(aid)['stale'] == 'grey')
        body['event_id'] = 'b' * 64
        body['reporting_status'] = {'version': 999999, 'interval_minutes': 1}
        api('/api/report', body, token=a['token'])
        check('未知客户端版本不能覆盖已确认周期', state(aid)['online_window_sec'] == 1020)
        body['event_id'] = 'c' * 64
        body['reporting_status'] = {'version': 1, 'interval_minutes': '8'}
        api('/api/report', body, token=a['token'], expected=400)
        check('异常实际周期上报被拒绝', True)
        # 重启同一临时数据库，验证默认值、单台设置和确认状态持久化。
        expected_policy = api('/api/state')['reporting_config']
        proc.terminate()
        proc.communicate(timeout=10)
        proc = subprocess.Popen([args.node, '--no-warnings', str(root / 'server/server.mjs'), '--port', str(port), '--db', str(dbpath), '--bootstrap', 'reporting-fixture'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                restored = api('/api/state')
                break
            except OSError:
                time.sleep(.1)
        check('重启保留配置、确认状态和历史', restored['reporting_config'] == expected_policy and state(aid)['online_window_sec'] == 1020)
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.communicate(timeout=10)
print(f'Reporting config checks: {passed} passed')
