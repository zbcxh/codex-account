"""功能：以临时密钥、数据库和回环服务验证 OTA 接口；参数：命令行 Node 路径；返回值：隔离断言结果。"""
import argparse
import hashlib
import json
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


def main():
    """功能：编排完全合成的 OTA 发布和设备交互；参数：无；返回值：无，异常表示失败。"""
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', default='D:/zhoubc/work/projects/codegraph/current/node.exe')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    admin = 'ota-http-synthetic-bootstrap'
    passed = 0
    # 回环调用不采用主机代理，防止将合成令牌发送到环境代理。
    opener = build_opener(ProxyHandler({}))

    def check(label, condition):
        """功能：验证并统计断言；参数：中文标签与条件；返回值：无。"""
        nonlocal passed
        assert condition, label
        passed += 1
        print('PASS', label, flush=True)

    with tempfile.TemporaryDirectory(prefix='quota-ota-http-') as directory:
        folder = Path(directory)
        # 密钥仅在本次临时 Node 进程内生成；磁盘只写临时公钥和合成字节，不创建正式信任根。
        fixture_script = r"""
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const folder=process.argv[1],keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const bytes=Buffer.from('synthetic executable - never execute'),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(folder,'public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
fs.writeFileSync(path.join(folder,sha256+'.exe'),bytes);
const now=Math.floor(Date.now()/1000);
/** 功能：使用临时私钥签发合成发布；参数：覆盖字段；返回值：原始清单与签名。 */
function envelope(extra={}){const manifest=JSON.stringify({protocol:1,release_seq:2,version:'2.0.0',platform:'win-x64',min_updater:1,filename:'CodexQuotaCollector.exe',sha256,size:bytes.length,issued_at:now-1,expires_at:now+3600,key_id:'fixture',...extra});return {manifest,signature:crypto.sign('RSA-SHA256',Buffer.from(manifest),keys.privateKey).toString('base64')};}
console.log(JSON.stringify({good:envelope(),next:envelope({release_seq:3,version:'3.0.0'}),wrongId:envelope({key_id:'untrusted'}),expired:envelope({expires_at:now-1}),sha256}));
"""
        fixture = json.loads(subprocess.check_output([args.node, '-e', fixture_script, str(folder)], text=True, encoding='utf-8', timeout=30))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        command = [args.node, '--no-warnings', str(root / 'server/server.mjs'), '--port', str(port),
                   '--allow', '127.0.0.0/8', '--read-gate', 'lan', '--db', str(folder / 'test.sqlite3'),
                   '--bootstrap', admin, '--ota-public-key', str(folder / 'public.pem'),
                   '--ota-key-id', 'fixture', '--ota-artifacts', str(folder)]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

        def api(path, body=None, token=None, administrator=False, pairing=None, expected=200, binary=False):
            """功能：只向临时回环服务发送请求；参数：路由、正文、令牌、授权、配对码、预期状态及二进制标记；返回值：JSON或字节。"""
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['x-quota-token'] = token
            if administrator or pairing:
                headers['x-quota-bootstrap'] = pairing or admin
            data = None if body is None else json.dumps(body).encode('utf-8')
            request = Request(base + path, data=data, headers=headers)
            try:
                with opener.open(request, timeout=10) as response:
                    status, raw = response.status, response.read()
            except HTTPError as error:
                with error:
                    status, raw = error.code, error.read()
            value = raw if binary and status == 200 else json.loads(raw)
            assert status == expected, (path, status, expected, value)
            return value

        try:
            ready = False
            # 有限等候本次子进程，不连接既有8787服务；启动失败时立即终止测试。
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError('合成 OTA 服务启动失败')
                try:
                    api('/api/state')
                    ready = True
                    break
                except (URLError, ConnectionError):
                    time.sleep(.1)
            check('临时服务及独立数据库启动', ready)
            code = api('/api/pairing-codes', {'name': 'OTA隔离设备', 'kind': 'permanent'}, administrator=True)['code']
            first = api('/api/pair', {'client_id': 'ota-http-one'}, pairing=code)
            other = api('/api/pair', {'client_id': 'ota-http-other'}, pairing=code)
            old = api('/api/pair', {'client_id': 'ota-http-old'}, pairing=code)
            check('合成设备独立配对', len({first['machine_id'], other['machine_id'], old['machine_id']}) == 3)
            api('/api/ota/releases', fixture['good'], expected=403)
            api('/api/ota/releases', fixture['wrongId'], administrator=True, expected=400)
            api('/api/ota/releases', fixture['expired'], administrator=True, expected=400)
            damaged = {**fixture['good'], 'signature': 'A' * 512}
            api('/api/ota/releases', damaged, administrator=True, expected=400)
            check('管理员授权、固定密钥ID、期限及签名门禁', not api('/api/ota/list', {}, administrator=True)['releases'])
            artifact = folder / (fixture['sha256'] + '.exe')
            original = artifact.read_bytes()
            artifact.write_bytes(b'invalid')
            api('/api/ota/releases', fixture['good'], administrator=True, expected=400)
            artifact.write_bytes(original)
            api('/api/ota/releases', fixture['good'], administrator=True)
            api('/api/ota/releases', fixture['good'], administrator=True)
            check('磁盘产物复核且发布重试幂等', len(api('/api/ota/list', {}, administrator=True)['releases']) == 1)
            cap = {'protocol': 1, 'release_seq': 1, 'key_id': 'fixture'}
            api('/api/client/ota/poll', {'capability': cap}, token='synthetic-wrong-token', expected=401)
            api('/api/client/ota/poll', {}, token=old['token'], expected=400)
            check('有效设备能力初始无任务', api('/api/client/ota/poll', {'capability': cap}, token=first['token'])['job'] is None)
            created = api('/api/ota/jobs', {'machine_ids': [first['machine_id'], old['machine_id']], 'release_seq': 2}, administrator=True)['results']
            job = created[0]['job']
            check('旧客户端不支持OTA且按设备返回', created[1]['error'] == 'ota_not_eligible')
            again = api('/api/ota/jobs', {'machine_ids': [first['machine_id']], 'release_seq': 2}, administrator=True)['results'][0]['job']
            check('重复创建复用同一任务', again['job_id'] == job['job_id'])
            claimed = api('/api/client/ota/poll', {'capability': cap}, token=first['token'])['job']
            check('领取包含原始签名和固定下载路径', claimed['manifest'] == fixture['good']['manifest'] and claimed['signature'] == fixture['good']['signature'] and claimed['download_path'] == '/api/client/ota/download/' + job['job_id'])
            api(claimed['download_path'], token=other['token'], expected=404)
            api(claimed['download_path'], token='synthetic-wrong-token', expected=401)
            api('/api/client/ota/ack', {'job_id': job['job_id'], 'state': 'verified'}, token=other['token'], expected=409)
            check('其他设备不能下载或确认目标任务', True)
            downloaded = api(claimed['download_path'], token=first['token'], binary=True)
            check('授权下载返回精确有界合成字节', downloaded == original and hashlib.sha256(downloaded).hexdigest() == fixture['sha256'])
            api('/api/client/ota/ack', {'job_id': job['job_id'], 'state': 'verified'}, token=first['token'])
            api('/api/client/ota/ack', {'job_id': job['job_id'], 'state': 'downloaded'}, token=first['token'], expected=409)
            api('/api/client/ota/ack', {'job_id': job['job_id'], 'state': 'installed'}, token=first['token'])
            api('/api/client/ota/ack', {'job_id': job['job_id'], 'state': 'installed'}, token=first['token'])
            check('终态确认幂等且不重放任务', api('/api/client/ota/poll', {'capability': cap}, token=first['token'])['job'] is None)
            api(claimed['download_path'], token=first['token'], expected=404)
            denied = api('/api/ota/jobs', {'machine_ids': [first['machine_id']], 'release_seq': 2}, administrator=True)['results'][0]
            check('成功后拒绝相同序号重建和下载', denied['error'] == 'ota_not_eligible')
            print(f'PASS OTA HTTP 隔离集成共 {passed} 项；未执行下载字节、未操作正式数据或计划任务。', flush=True)
        finally:
            # 只停止本次持有句柄的临时服务，绝不扫描或终止其他Node进程。
            if process.poll() is None:
                process.terminate()
            try:
                output, _ = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                output, _ = process.communicate(timeout=10)
            if sys.exc_info()[0] is not None:
                print(output.decode('utf-8', errors='replace'), file=sys.stderr)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
