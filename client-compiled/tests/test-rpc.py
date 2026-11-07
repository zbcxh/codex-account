import argparse
import hashlib
import shutil
import http.server
import json
import os
import pathlib
import re
import socket
import ssl
import subprocess
import tempfile
import threading

ROOT = pathlib.Path(__file__).parent
parser = argparse.ArgumentParser()
parser.add_argument('--exe', type=pathlib.Path, default=ROOT.parent/'bin/CodexQuotaPrototype.exe')
parser.add_argument('--repo', type=pathlib.Path, default=ROOT.parents[1])
options = parser.parse_args()
EXE = options.exe.resolve()
CSC = pathlib.Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
git = pathlib.Path(shutil.which('git.exe') or shutil.which('git') or '.')
bundled_openssl = git.parent.parent/'usr/bin/openssl.exe'
OPENSSL = bundled_openssl if bundled_openssl.is_file() else pathlib.Path(shutil.which('openssl') or '')
assert OPENSSL.is_file(), '隔离 HTTPS 测试需要现有 OpenSSL，不会自动安装。'
passes = []


def run(*args, success=True, env=None):
    """功能：运行独立原型并解析脱敏结果。参数：选项、预期成功标记和合成环境。返回：解析对象。"""
    result = subprocess.run([str(EXE), *args], capture_output=True, timeout=20, env=env)
    assert (result.returncode == 0) == success, (args, result.returncode, result.stdout, result.stderr)
    return json.loads((result.stdout if success else result.stderr).decode('utf-8-sig'))


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    """功能：模拟现有服务端上报协议。参数：HTTP 请求。返回：固定确认，不写真实数据。"""
    mode = 'ok'
    received = []

    def log_message(self, *args):
        """功能：抑制合成服务日志。参数：默认日志参数。返回：无。"""
        pass

    def do_POST(self):
        """功能：校验合成上报与请求头。参数：无。返回：测试用确认响应。"""
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.path == '/api/report'
        assert self.headers['x-quota-token'] == 'fixture-token'
        assert payload['account_id'] == '11111111-1111-1111-1111-111111111111'
        assert payload['source'] == 'app_server'
        assert payload['primary']['used_percent'] == 23
        assert payload['primary']['window_minutes'] == 300
        assert len(payload['event_id']) == 64
        assert 'email' not in payload and 'token' not in payload
        self.received.append(payload)
        if self.mode == 'redirect':
            self.send_response(307)
            self.send_header('Location', 'https://never-contact.example.invalid/api/report')
            self.end_headers()
            return
        body = json.dumps({'ok': True, 'reporting_config': {'version': 1, 'interval_minutes': 5}}).encode()
        if self.mode == 'large':
            body = b' ' * 66000 + body
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


with tempfile.TemporaryDirectory(prefix='quota-prototype-fixture-') as temporary:
    tmp = pathlib.Path(temporary)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f'http://127.0.0.1:{server.server_port}'
        assert run('--fixture-transport', '--server', url)['reporting_config_received']
        passes.append('HTTP POST path, JSON fields, token header and reporting response compatible')
        FixtureHandler.mode = 'redirect'
        assert run('--fixture-transport', '--server', url, success=False)['error'] == 'fixture_bad_status'
        passes.append('Redirect rejected without forwarding token')
        FixtureHandler.mode = 'large'
        assert run('--fixture-transport', '--server', url, success=False)['error'] == 'fixture_response_too_large'
        passes.append('Response memory bounded')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
        FixtureHandler.mode = 'ok'

    cert, key, der = tmp/'cert.pem', tmp/'key.pem', tmp/'cert.der'
    subprocess.run([str(OPENSSL), 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
                    '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
    subprocess.run([str(OPENSSL), 'x509', '-in', str(cert), '-outform', 'DER', '-out', str(der)], check=True, capture_output=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f'https://localhost:{server.server_port}'
        run('--fixture-transport', '--server', url, success=False)
        passes.append('Untrusted HTTPS certificate rejected by default')
        assert run('--fixture-transport', '--server', url, '--fixture-cert', str(der))['status'] == 200
        passes.append('HTTPS transport works with explicit synthetic loopback certificate')
        run('--fixture-transport', '--server', f'https://127.0.0.1:{server.server_port}', '--fixture-cert', str(der), success=False)
        passes.append('HTTPS hostname mismatch rejected even in pinned fixture')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

    run('--fixture-transport', '--server', 'https://quota.example.invalid', success=False)
    passes.append('Synthetic send cannot target non-loopback server')
    run('--server', 'https://user:secret@quota.example.invalid', success=False)
    passes.append('Server URL cannot carry credentials')
    run('--server', 'https://quota.example.invalid', '--fixture-cert', str(der), success=False)
    passes.append('Fixture certificate cannot affect real account collection')

    # 复用已验证的合成 app-server，对双方使用同一协议与 plugins 参数。
    fake = (ROOT/'FakeAppServer.cs').read_text(encoding='utf-8-sig')
    fake = fake.replace('string line;', '''string mode = Environment.GetEnvironmentVariable("QUOTA_PROTO_FIXTURE_MODE");
        string audit = Environment.GetEnvironmentVariable("QUOTA_PROTO_FIXTURE_AUDIT");
        string line;''')
    fake = fake.replace('if (!match.Success) continue;', '''if (audit != null) System.IO.File.AppendAllText(audit, line + "\\n");
            if (!match.Success) continue;''')
    fake = fake.replace('int id = int.Parse(match.Groups[1].Value);', '''int id = int.Parse(match.Groups[1].Value);
            if (mode == "timeout") System.Threading.Thread.Sleep(2000);
            if (mode == "oversize") { Console.WriteLine(new string('x', 1048577)); Console.Out.Flush(); continue; }
            if (mode == "invalid_json") { Console.WriteLine("{broken"); Console.Out.Flush(); continue; }''')
    fake = fake.replace('Console.WriteLine("{\\"id\\":" + id', '''if (mode == "mismatch" && id == 3) body = body.Replace("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
            Console.WriteLine("{\\"id\\":" + id''')
    fake_source, fake_exe, audit = tmp/'Fake.cs', tmp/'fake-codex.exe', tmp/'audit.jsonl'
    fake_source.write_text(fake, encoding='utf-8-sig')
    subprocess.run([str(CSC), '/nologo', '/optimize+', '/target:exe', f'/out:{fake_exe}', str(fake_source)], check=True, capture_output=True)
    env = dict(os.environ, QUOTA_PROTO_FIXTURE_AUDIT=str(audit))
    result = run('--codex', str(fake_exe), '--server', 'https://quota.example.invalid', env=env)
    assert result['account_verified'] and not result['sent_report']
    calls = [json.loads(line) for line in audit.read_text().splitlines()]
    assert [call['method'] for call in calls] == ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read']
    assert all(call['params']['refreshToken'] is False for call in calls if call['method'] == 'account/read')
    passes.append('4 MiB stderr drains; exactly read-only RPC; no refreshToken request')
    for mode in ['mismatch', 'timeout', 'oversize', 'invalid_json']:
        env = dict(os.environ, QUOTA_PROTO_FIXTURE_MODE=mode)
        options = ['--codex', str(fake_exe)]
        if mode == 'timeout':
            options += ['--timeout-ms', '100']
        result = run(*options, success=False, env=env)
        if mode == 'mismatch':
            assert result['error'] == 'ownership_mismatch'
        passes.append(f'RPC {mode} fails closed')

report = {'passed': len(passes), 'checks': passes, 'compiled_selftest': run('--self-test')}
# 结果仅通过标准输出交付，不在源码树累积历史运行数据。
print(json.dumps(report, ensure_ascii=True, indent=2))
