using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Diagnostics;
using System.Security.Principal;

/// <summary>只监听环回地址的合成 HTTP 服务。参数：合成任务与程序。返回：请求记录。</summary>
public sealed class OtaHttpFixture : IDisposable
{
    private readonly TcpListener listener;
    private readonly Thread worker;
    public string Url;
    public Dictionary<string, object> Job;
    public byte[] Artifact;
    public bool Replay, Redirect, Slow;
    public int Downloads, Polls;
    public Exception Failure;
    /// <summary>启动环回临时端口。参数：合成任务与包。返回：实例。</summary>
    public OtaHttpFixture(Dictionary<string, object> job, byte[] artifact) { Job = job; Artifact = artifact; listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); Url = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port; worker = new Thread(Serve); worker.IsBackground = true; worker.Start(); }
    /// <summary>处理有界测试请求。参数：无。返回：无。</summary>
    private void Serve()
    {
        try { while (true) { using (var client = listener.AcceptTcpClient()) using (var stream = client.GetStream()) using (var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true)) {
            stream.ReadTimeout = 5000; string line = reader.ReadLine(); if (line == null) continue; string path = line.Split(' ')[1], token = null; int length = 0; bool expect = false;
            // 读取实际网络头，确认令牌只发送到环回同源接口。
            while (!String.IsNullOrEmpty(line = reader.ReadLine())) { int colon = line.IndexOf(':'); if (colon < 0) continue; string name = line.Substring(0, colon).ToLowerInvariant(), value = line.Substring(colon + 1).Trim(); if (name == "content-length") length = Int32.Parse(value); if (name == "x-quota-token") token = value; if (name == "expect") expect = true; }
            if (token != "synthetic-device-token" || length > 65536) throw new Exception("fixture_auth_or_size");
            if (expect) { byte[] interim = Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n"); stream.Write(interim, 0, interim.Length); }
            char[] body = new char[length]; int got = 0; while (got < length) { int read = reader.Read(body, got, length - got); if (read == 0) throw new Exception("fixture_truncated"); got += read; }
            byte[] result; string status = "200 OK", headers = "";
            if (path == "/api/client/ota/poll") { Polls++; result = Encoding.UTF8.GetBytes(OtaCore.Json.Serialize(QuotaPrototype.Obj("ok", true, "job", Job, "replay", Replay))); }
            else if (path.StartsWith("/api/client/ota/download/", StringComparison.Ordinal)) { Downloads++; if (Slow) Thread.Sleep(1000); result = Artifact; if (Redirect) { status = "302 Found"; headers = "Location: http://example.invalid/never-contact\r\n"; result = new byte[0]; } }
            else if (path == "/api/client/ota/ack") result = Encoding.ASCII.GetBytes("{\"ok\":true}");
            else throw new Exception("fixture_wrong_path_" + path);
            byte[] head = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: " + result.Length + "\r\n" + headers + "\r\n"); stream.Write(head, 0, head.Length); stream.Write(result, 0, result.Length);
        } } } catch (SocketException) { } catch (ObjectDisposedException) { } catch (IOException error) { if (!Slow) Failure = error; } catch (Exception error) { Failure = error; }
    }
    /// <summary>停止合成服务并等待线程退出。参数：无。返回：无。</summary>
    public void Dispose() { listener.Stop(); if (!worker.Join(6000)) throw new Exception("fixture_thread"); if (Failure != null) throw new Exception("fixture_failure", Failure); }
}

/// <summary>网络使用正式实现、任务使用内存替身。参数：接口参数。返回：合成任务状态。</summary>
public sealed class OtaTestEnvironment : IOtaEnvironment
{
    private readonly WindowsOtaEnvironment windows = new WindowsOtaEnvironment();
    public int Starts;
    /// <summary>通过真实 HTTP 请求发送。参数：地址、令牌及正文。返回：响应。</summary>
    public Dictionary<string, object> Post(Uri endpoint, string token, string body) { return windows.Post(endpoint, token, body); }
    /// <summary>通过真实 HTTP 流式下载。参数：地址、令牌、目标与清单。返回：无。</summary>
    public void Download(Uri endpoint, string token, string destination, Dictionary<string, object> manifest) { windows.Download(endpoint, token, destination, manifest); }
    /// <summary>记录固定任务启动请求，不连接 COM。参数：任务、根、类型与运行标记。返回：稳定 XML 替身。</summary>
    public string Task(string name, string root, bool updater, bool run) { if (run) { using (var probe = OtaCore.TryLock(OtaCore.PathIn(root, "ota/poll.lock"))) { if (probe == null) throw new Exception("updater_started_inside_poll_lock"); } Starts++; } return updater ? "synthetic updater xml" : "synthetic collector xml"; }
    /// <summary>返回未运行状态以验证不擅自启动。参数：任务与根。返回：假。</summary>
    public bool IsRunning(string name, string root) { return false; }
    /// <summary>返回纯合成令牌，不读取 DPAPI。参数：根。返回：合成令牌。</summary>
    public string Token(string root) { return "synthetic-device-token"; }
}

/// <summary>纯临时密钥及合成包 OTA 验证。参数：无。返回：测试退出码。</summary>
public static class OtaTests
{
    private static int assertions;
    /// <summary>断言拒绝异常。参数：预期失败操作。返回：无。</summary>
    private static void Reject(Action action) { bool refused = false; try { action(); } catch { refused = true; } if (!refused) throw new Exception("expected_refusal"); assertions++; }
    /// <summary>计算内存合成包摘要。参数：内容。返回：摘要。</summary>
    private static string Hash(byte[] bytes) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    /// <summary>用临时密钥签名原始清单。参数：密钥、清单。返回：签名。</summary>
    private static string Sign(RSACryptoServiceProvider rsa, string manifest) { return Convert.ToBase64String(rsa.SignData(Encoding.UTF8.GetBytes(manifest), CryptoConfig.MapNameToOID("SHA256"))); }
    /// <summary>建立纯合成事务根并验证每个断电点恢复。参数：测试父目录。返回：无。</summary>
    private static void Transactions(string parent)
    {
        string[] points = { "before_replace", "after_replace", "after_replaced_log", "before_health", "after_health", "after_installed_log", "before_rollback", "after_rollback" };
        // 每个阶段使用独立设备替身，所有身份文件仅为合成固定字节。
        foreach (string point in points) {
            string root = Path.Combine(parent, point); Directory.CreateDirectory(Path.Combine(root, "bin")); Directory.CreateDirectory(Path.Combine(root, "ota")); Directory.CreateDirectory(Path.Combine(root, "spool"));
            byte[] old = Encoding.UTF8.GetBytes("old synthetic exe"), next = Encoding.UTF8.GetBytes("new synthetic exe");
            File.WriteAllBytes(Path.Combine(root, "bin/CodexQuotaCollector.exe"), old); File.WriteAllBytes(Path.Combine(root, "ota/candidate.exe"), next);
            string[] unchanged = { "config.json", "token.bin", "resident.paused.json", "resident.schedule.json", "spool/queued.json" };
            foreach (string file in unchanged) File.WriteAllText(Path.Combine(root, file), "synthetic " + file);
            var state = new Dictionary<string, object> { { "phase", "verified" }, { "previous_hash", Hash(old) }, { "highest_seq", 2 } };
            Action<string> persist = delegate(string phase) { state["phase"] = phase; OtaCore.Save(root, state); };
            bool healthy = point != "before_rollback" && point != "after_rollback";
            Reject(delegate { OtaTransaction.Run(root, state, Hash(next), delegate { return healthy; }, persist, delegate(string step) { if (step == point) throw new IOException("synthetic_power_loss"); }); });
            state = OtaClient.State(root); OtaTransaction.Run(root, state, Hash(next), delegate { return healthy; }, persist, delegate(string step) { });
            if (QuotaClient.String(state, "phase") != (healthy ? "installed" : "rolled_back") || OtaCore.Hash(Path.Combine(root, "bin/CodexQuotaCollector.exe")) != Hash(healthy ? next : old) || Convert.ToInt32(state["highest_seq"]) != 2) throw new Exception("recovery_" + point); assertions++;
            foreach (string file in unchanged) { if (File.ReadAllText(Path.Combine(root, file)) != "synthetic " + file) throw new Exception("identity_changed"); assertions++; }
            // 重复最终任务不得再次验收或替换程序。
            OtaTransaction.Run(root, state, Hash(next), delegate { throw new Exception("duplicate_health"); }, persist, delegate(string step) { throw new Exception("duplicate_checkpoint"); }); assertions++;
        }
        string conflict = Path.Combine(parent, "conflict"); Directory.CreateDirectory(Path.Combine(conflict, "bin")); Directory.CreateDirectory(Path.Combine(conflict, "ota"));
        File.WriteAllText(Path.Combine(conflict, "bin/CodexQuotaCollector.exe"), "third party"); File.WriteAllText(Path.Combine(conflict, "ota/candidate.exe"), "new");
        var record = new Dictionary<string, object> { { "phase", "verified" }, { "previous_hash", Hash(Encoding.UTF8.GetBytes("old")) } };
        Reject(delegate { OtaTransaction.Run(conflict, record, Hash(Encoding.UTF8.GetBytes("new")), delegate { return true; }, delegate(string phase) { record["phase"] = phase; }, delegate(string point) { }); });
        if (File.ReadAllText(Path.Combine(conflict, "bin/CodexQuotaCollector.exe")) != "third party") throw new Exception("third_party_overwritten"); assertions++;
        File.WriteAllText(Path.Combine(conflict, "bin/CodexQuotaCollector.exe"), "old"); record["phase"] = "verified"; int guards = 0;
        // 模拟等待生命周期锁期间或替换意图落盘后任务被第三方改变。
        Reject(delegate { OtaTransaction.Run(conflict, record, Hash(Encoding.UTF8.GetBytes("new")), delegate { return true; }, delegate(string phase) { record["phase"] = phase; }, delegate(string point) { }, delegate { if (++guards == 2) throw new InvalidOperationException("ota_task_changed"); }); });
        if (File.ReadAllText(Path.Combine(conflict, "bin/CodexQuotaCollector.exe")) != "old" || !File.Exists(Path.Combine(conflict, "ota/candidate.exe"))) throw new Exception("task_guard_overwritten"); assertions++;
        record["phase"] = "verified";
        OtaTransaction.Run(conflict, record, Hash(Encoding.UTF8.GetBytes("new")), delegate { return OtaCore.RunHealth(Path.Combine(conflict, "bin/CodexQuotaCollector.exe"), conflict); }, delegate(string phase) { record["phase"] = phase; }, delegate(string point) { });
        if (QuotaClient.String(record, "phase") != "rolled_back" || File.ReadAllText(Path.Combine(conflict, "bin/CodexQuotaCollector.exe")) != "old") throw new Exception("invalid_exe_not_rolled_back"); assertions++;
        File.WriteAllText(Path.Combine(conflict, "ota/candidate.exe"), "new"); record["phase"] = "verified";
        Reject(delegate { OtaTransaction.Run(conflict, record, Hash(Encoding.UTF8.GetBytes("new")), delegate { throw new InvalidOperationException("cleanup_unknown"); }, delegate(string phase) { record["phase"] = phase; }, delegate(string point) { }); });
        if (QuotaClient.String(record, "phase") != "replaced" || !File.Exists(Path.Combine(conflict, "ota/previous.exe"))) throw new Exception("unknown_health_lost_evidence"); assertions++;
    }
    /// <summary>通过真实环回 HTTP 验证领取、验签、下载与固定任务边界。参数：临时父目录、临时密钥及根。返回：无。</summary>
    private static void HttpPolls(string parent, RSACryptoServiceProvider rsa, Dictionary<string, object> trust)
    {
        foreach (string scenario in new[] { "valid", "foreign_path", "replayed", "redirect" }) {
            string root = Path.Combine(parent, "http_" + scenario); QuotaClient.PrivateDirectory(root, root); QuotaClient.PrivateDirectory(root, Path.Combine(root, "bin"));
            File.WriteAllText(Path.Combine(root, "bin/CodexQuotaCollector.exe"), "old synthetic collector"); QuotaClient.Atomic(root, Path.Combine(root, "ota.trust.json"), OtaCore.Json.Serialize(trust));
            byte[] bytes = Encoding.UTF8.GetBytes("new synthetic collector"); long now = OtaCore.Now();
            var m = QuotaPrototype.Obj("protocol", 1, "release_seq", 4, "version", "1.0.0", "platform", "win-x64", "min_updater", 1, "filename", "CodexQuotaCollector.exe", "sha256", Hash(bytes), "size", bytes.Length, "issued_at", now - 10, "expires_at", now + 600, "key_id", "temporary_test");
            string raw = OtaCore.Json.Serialize(m), id = Guid.NewGuid().ToString("D");
            var job = QuotaPrototype.Obj("job_id", id, "client_id", "synthetic_client", "machine_id", "synthetic_machine", "seq", 4, "manifest", raw, "signature", Sign(rsa, raw), "download_path", scenario == "foreign_path" ? "http://foreign.invalid/evil" : "/api/client/ota/download/" + id);
            using (var fixture = new OtaHttpFixture(job, bytes)) {
                fixture.Replay = scenario == "replayed"; fixture.Redirect = scenario == "redirect";
                var config = QuotaPrototype.Obj("client_id", "synthetic_client", "server_url", fixture.Url, "task_name", "SyntheticTask"); var env = new OtaTestEnvironment();
                OtaClient.Poll(root, config, env); var state = OtaClient.State(root);
                if (scenario == "valid") { if (QuotaClient.String(state, "phase") != "verified" || fixture.Downloads != 1 || env.Starts != 1 || !Object.Equals(state["was_running"], false)) throw new Exception("poll_valid"); assertions++; OtaClient.Poll(root, config, env); if (fixture.Downloads != 1 || fixture.Polls != 1) throw new Exception("poll_duplicate_download"); assertions++; }
                else { if (env.Starts != 0 || (scenario != "redirect" && fixture.Downloads != 0) || File.Exists(Path.Combine(root, "ota/candidate.exe"))) throw new Exception("poll_invalid_" + scenario); assertions++; }
                if (File.ReadAllText(Path.Combine(root, "bin/CodexQuotaCollector.exe")) != "old synthetic collector") throw new Exception("poll_replaced_in_collector"); assertions++;
            }
        }
    }
    /// <summary>隔离测试入口，不读取真实配置或任务。参数：无。返回：零表示全部通过。</summary>
    public static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "synthetic-health") { Thread.Sleep(750); return 0; }
        string directory = Path.Combine(Path.GetTempPath(), "quota-ota-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        try { using (var rsa = new RSACryptoServiceProvider(3072)) {
            rsa.PersistKeyInCsp = false; var key = rsa.ExportParameters(false);
            var trust = new Dictionary<string, object> { { "key_id", "temporary_test" }, { "modulus", Convert.ToBase64String(key.Modulus) }, { "exponent", Convert.ToBase64String(key.Exponent) } };
            byte[] bytes = Encoding.UTF8.GetBytes("MZ synthetic artifact only");
            string raw = "{\"protocol\":1,\"release_seq\":2,\"version\":\"1.2.3\",\"platform\":\"win-x64\",\"min_updater\":1,\"filename\":\"CodexQuotaCollector.exe\",\"sha256\":\"" + Hash(bytes) + "\",\"size\":" + bytes.Length + ",\"issued_at\":100,\"expires_at\":1000,\"key_id\":\"temporary_test\"}";
            string signature = Sign(rsa, raw); var manifest = OtaCore.Verify(raw, signature, trust, 1, 200); assertions++;
            Reject(delegate { OtaCore.Verify(raw + " ", signature, trust, 1, 200); });
            Reject(delegate { OtaCore.Verify(raw, signature, trust, 2, 200); });
            Reject(delegate { OtaCore.Verify(raw, signature, trust, 1, 1000); });
            // 所有非法结构也重新正确签名，证明结构门禁独立于签名门禁。
            foreach (string invalid in new[] { raw.Replace("\"protocol\":1", "\"protocol\":1,\"protocol\":1"), raw.Replace("\"protocol\":1", "\"protocol\":\"1\""), raw.Replace("\"protocol\":1", "\"protocol\":1.0"), raw.Replace("win-x64", "win-arm64"), raw.Replace("\"size\":" + bytes.Length, "\"size\":20971521"), raw.Replace("temporary_test", "other_key"), raw.Replace("\"version\":\"1.2.3\"", "\"version\":{}") }) { string copy = invalid; Reject(delegate { OtaCore.Verify(copy, Sign(rsa, copy), trust, 1, 200); }); }
            string output = Path.Combine(directory, "candidate.exe"); OtaCore.CopyVerified(new MemoryStream(bytes), output, manifest); if (File.ReadAllBytes(output).Length != bytes.Length) throw new Exception("copy"); assertions++; File.Delete(output);
            Reject(delegate { OtaCore.CopyVerified(new MemoryStream(new byte[bytes.Length + 1]), output, manifest); });
            Reject(delegate { OtaCore.CopyVerified(new MemoryStream(new byte[bytes.Length - 1]), output, manifest); });
            Reject(delegate { OtaCore.CopyVerified(new MemoryStream(new byte[bytes.Length]), output, manifest); });
            if (File.Exists(output)) throw new Exception("partial_artifact_retained"); assertions++;
            Reject(delegate { OtaCore.PathIn(directory, Path.Combine(directory, "..", "escape")); });
            HttpPolls(directory, rsa, trust);
        } Transactions(directory); BindingAndLock(directory); ResourceWindow(); Console.WriteLine("OTA isolated assertions=" + assertions); return 0; }
        catch (Exception error) { Console.WriteLine("OTA test failure type=" + error.GetType().Name + " message=" + error.Message); return 1; }
        finally { Directory.Delete(directory, true); }
    }
    /// <summary>验证 PID 复用和锁缺失不能冒充持锁。参数：临时父目录。返回：无。</summary>
    private static void BindingAndLock(string parent)
    {
        string root = Path.Combine(parent, "binding"); Directory.CreateDirectory(root); Directory.CreateDirectory(Path.Combine(root, "ota"));
        using (var self = Process.GetCurrentProcess()) {
            var state = QuotaPrototype.Obj("phase", "installed", "updater_pid", self.Id, "updater_start_ticks", self.StartTime.ToUniversalTime().Ticks - 1); OtaCore.Save(root, state);
            OtaClient.WaitForUpdater(root); assertions++;
            File.WriteAllText(Path.Combine(root, "ota/stop.request"), "synthetic"); Reject(delegate { OtaClient.WaitForUpdater(root); }); File.Delete(Path.Combine(root, "ota/stop.request"));
            state["updater_start_ticks"] = self.StartTime.ToUniversalTime().Ticks; OtaCore.Save(root, state); Reject(delegate { OtaClient.WaitForUpdater(root); });
        }
        string path = Path.Combine(root, "ota/upgrade.lock"); Reject(delegate { OtaCore.RequireHeldLock(path); }); File.WriteAllText(path, ""); Reject(delegate { OtaCore.RequireHeldLock(path); });
        using (var held = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { OtaCore.RequireHeldLock(path); assertions++; }
        using (var held = OtaCore.TryLock(Path.Combine(root, "ota/poll.lock"))) { using (var second = OtaCore.TryLock(Path.Combine(root, "ota/poll.lock"))) { if (second != null) throw new Exception("concurrent_poll_lock"); assertions++; } }
        string sid = WindowsIdentity.GetCurrent().User.Value;
        string xml = "<Task><Principals><Principal id=\"Author\"><UserId>" + sid + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Actions Context=\"Author\"><Exec><Command>" + OtaCore.PathIn(root, "bin/CodexQuotaUpdater.exe") + "</Command><Arguments>--apply</Arguments></Exec></Actions></Task>";
        OtaTasks.Validate(root, xml, true); assertions++;
        foreach (string bad in new[] { xml.Replace("LeastPrivilege", "HighestAvailable"), xml.Replace("Context=\"Author\"", "Context=\"Other\""), xml.Replace("</Principals>", "<Principal id=\"Other\"><UserId>" + sid + "</UserId></Principal></Principals>") }) { string copy = bad; Reject(delegate { OtaTasks.Validate(root, copy, true); }); }
        byte[] package = Encoding.UTF8.GetBytes("synthetic expired"); string candidate = Path.Combine(root, "ota/candidate.exe"); File.WriteAllBytes(candidate, package);
        var stateExpiry = QuotaPrototype.Obj("phase", "verified", "highest_seq", 7); var expiryManifest = QuotaPrototype.Obj("expires_at", 200, "sha256", Hash(package));
        if (!OtaCore.ExpireVerified(root, stateExpiry, expiryManifest, 200) || QuotaClient.String(OtaClient.State(root), "phase") != "failed" || File.Exists(candidate) || Convert.ToInt32(stateExpiry["highest_seq"]) != 7) throw new Exception("expired_verified_stuck"); assertions++;
        using (var fixture = new OtaHttpFixture(null, package)) { fixture.Slow = true; var watch = Stopwatch.StartNew(); Reject(delegate { OtaCore.Download(new Uri(fixture.Url + "/api/client/ota/download/synthetic"), "synthetic-device-token", candidate, QuotaPrototype.Obj("size", package.Length, "sha256", Hash(package)), 100); }); if (watch.ElapsedMilliseconds >= 900 || File.Exists(candidate)) throw new Exception("download_deadline"); assertions++; }
    }
    /// <summary>测量独立进程健康窗口的合计提交与CPU，不启动官方程序。参数：无。返回：无。</summary>
    private static void ResourceWindow()
    {
        long peak = 0; using (var self = Process.GetCurrentProcess()) using (var child = Process.Start(new ProcessStartInfo(typeof(OtaTests).Assembly.Location, "synthetic-health") { UseShellExecute = false, CreateNoWindow = true })) {
            TimeSpan cpu = self.TotalProcessorTime; var watch = Stopwatch.StartNew();
            // 仅采样本测试创建的健康进程，不能按名字枚举真实采集器。
            while (!child.WaitForExit(10)) { try { self.Refresh(); child.Refresh(); peak = Math.Max(peak, self.PrivateMemorySize64 + child.PrivateMemorySize64); } catch (InvalidOperationException) { if (child.HasExited) break; throw; } }
            watch.Stop(); if (child.ExitCode != 0 || peak <= 0 || peak >= 300L * 1048576) throw new Exception("synthetic_upgrade_resource"); assertions++;
            Console.WriteLine("OTA synthetic health window combined_private_mib=" + (peak / 1048576) + " parent_cpu_ms=" + (self.TotalProcessorTime - cpu).TotalMilliseconds + " wall_ms=" + watch.ElapsedMilliseconds);
        }
    }
}
