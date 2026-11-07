import argparse
import contextlib
import json
import pathlib
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

ROOT = pathlib.Path(__file__).parent
parser = argparse.ArgumentParser()
parser.add_argument('--node', required=True, type=pathlib.Path, help='真实 Node 可执行文件绝对路径')
parser.add_argument('--repo', type=pathlib.Path, default=ROOT.parents[1])
parser.add_argument('--exe', type=pathlib.Path, default=ROOT.parent/'bin/CodexQuotaPrototype.exe')
options = parser.parse_args()
REPO = options.repo.resolve()
NODE = options.node.resolve()
assert NODE.is_file()


def request(url, body=None, pairing_code=None):
    """功能：访问隔离测试服务。参数：回环 URL、可选合成请求体及配对码。返回：JSON 响应。"""
    headers = {'Content-Type': 'application/json', 'x-quota-bootstrap': pairing_code or 'fixture-bootstrap'}
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data, headers), timeout=3) as response:
        return json.load(response)


with tempfile.TemporaryDirectory(prefix='quota-contract-fixture-') as temporary:
    fixture = pathlib.Path(temporary).resolve()
    database = fixture/'quota.sqlite3'
    assert database.parent == fixture
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    # 明确指定临时数据库和随机端口，禁止借用生产数据库或 8787 端口。
    assert port != 8787
    with (fixture/'server.log').open('wb') as log:
        process = subprocess.Popen([str(NODE), '--no-warnings', str(REPO/'server/server.mjs'), '--port', str(port), '--db', str(database), '--bootstrap', 'fixture-bootstrap'], stdout=log, stderr=log)
        try:
            base = f'http://127.0.0.1:{port}'
            for attempt in range(60):
                if process.poll() is not None:
                    raise RuntimeError('隔离后端提前退出')
                try:
                    request(base+'/api/state')
                    break
                except Exception:
                    time.sleep(.1)
            else:
                raise RuntimeError('隔离后端未就绪')
            code = request(base+'/api/pairing-codes', {'name': '契约合成配对码', 'kind': 'single'})
            paired = request(base+'/api/pair', {'client_id': 'prototype-fixture', 'hostname': 'fixture', 'label': 'fixture'}, pairing_code=code['code'])
            # 仅修改新建临时数据库中的合成令牌，使固定测试请求可通过现有真实鉴权路径。
            with contextlib.closing(sqlite3.connect(database)) as conn:
                conn.execute('UPDATE machine SET token=? WHERE machine_id=?', ('fixture-token', paired['machine_id']))
                conn.commit()
            result = subprocess.run([str(options.exe.resolve()), '--fixture-transport', '--server', base], capture_output=True, timeout=15)
            assert result.returncode == 0, result.stderr
            assert json.loads(result.stdout)['reporting_config_received']
            state = request(base+'/api/state')
            assert len(state['machines']) == 1
            assert state['machines'][0]['account_id'] == '11111111-1111-1111-1111-111111111111'
            assert state['machines'][0]['source'] == 'app_server'
            report = {'ok': True, 'existing_backend_report_accepted': True, 'existing_reporting_response_received': True, 'temporary_database_only': True}
            # 结果仅通过标准输出交付，不在源码树累积历史运行数据。
            print(json.dumps(report))
        finally:
            # 只结束本测试通过实际 Node 路径启动的合成服务，不查杀其他进程。
            process.terminate()
            process.wait(timeout=10)
