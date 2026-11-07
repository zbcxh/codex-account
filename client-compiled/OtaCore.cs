using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.ComponentModel;

/// <summary>可隔离的 OTA 外部边界；正式入口固定使用 Windows 实现。参数：API、任务或设备根。返回：真实结果或测试替身。</summary>
public interface IOtaEnvironment
{
    /// <summary>发送单次 JSON。参数：地址、令牌、正文。返回：响应。</summary>
    Dictionary<string, object> Post(Uri endpoint, string token, string body);
    /// <summary>流式下载。参数：地址、令牌、目标及清单。返回：无。</summary>
    void Download(Uri endpoint, string token, string destination, Dictionary<string, object> manifest);
    /// <summary>检查或运行固定任务。参数：名称、根、升级器标记及运行标记。返回：XML。</summary>
    string Task(string name, string root, bool updater, bool run);
    /// <summary>读取任务运行态。参数：名称及根。返回：是否运行。</summary>
    bool IsRunning(string name, string root);
    /// <summary>读取设备令牌。参数：根。返回：内存令牌。</summary>
    string Token(string root);
}

/// <summary>正式 OTA 的固定 Windows 边界，无可由服务端指定的命令。参数：接口参数。返回：系统结果。</summary>
public sealed class WindowsOtaEnvironment : IOtaEnvironment
{
    /// <summary>发送一次请求。参数：地址、令牌、正文。返回：响应。</summary>
    public Dictionary<string, object> Post(Uri endpoint, string token, string body) { return QuotaClient.Post(endpoint, token, body); }
    /// <summary>下载并验包，不跟随重定向。参数：地址、令牌、目标及清单。返回：无。</summary>
    public void Download(Uri endpoint, string token, string destination, Dictionary<string, object> manifest) { OtaCore.Download(endpoint, token, destination, manifest, 120000); }
    /// <summary>调用固定任务。参数：名称、根、类型及运行标记。返回：XML。</summary>
    public string Task(string name, string root, bool updater, bool run) { return OtaTasks.Access(name, root, updater, run); }
    /// <summary>读取运行态。参数：名称与根。返回：运行标记。</summary>
    public bool IsRunning(string name, string root) { return OtaTasks.IsRunning(name, root); }
    /// <summary>读取已有 DPAPI 令牌。参数：根。返回：内存令牌。</summary>
    public string Token(string root) { return QuotaClient.Token(root); }
}

/// <summary>固定信任根下的 OTA 原语。参数：私有状态根及签名清单。返回：验证结果或拒绝异常。</summary>
public static class OtaCore
{
    public static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    /// <summary>取得私有根内的路径。参数：根与相对路径。返回：已检查的完整路径。</summary>
    public static string PathIn(string root, string relative) { return QuotaClient.Fence(root, Path.Combine(root, relative)); }
    /// <summary>取得文件摘要。参数：文件路径。返回：小写 SHA-256。</summary>
    public static string Hash(string path) { using (var s = File.OpenRead(path)) using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant(); }
    /// <summary>取得当前 Unix 秒。参数：无。返回：整数秒。</summary>
    public static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalSeconds; }
    /// <summary>验证既有锁确实被独占持有，仅共享冲突代表占用。参数：锁路径。返回：无，缺失或其他读失败拒绝。</summary>
    public static void RequireHeldLock(string path)
    {
        if (!File.Exists(path)) throw new InvalidOperationException("ota_health_lock_missing");
        try { using (var probe = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None)) { } }
        catch (IOException error) { int code = error.HResult & 65535; if (code == 32 || code == 33) return; throw; }
        throw new InvalidOperationException("ota_health_lock_unheld");
    }
    /// <summary>尝试获取协调锁，仅占用时延期，其他错误保留。参数：锁路径。返回：锁或空。</summary>
    public static FileStream TryLock(string path) { try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); } catch (IOException error) { int code = error.HResult & 65535; if (code == 32 || code == 33) return null; throw; } }
    /// <summary>带整次时限的固定地址下载，慢滴也会中断。参数：同源地址、令牌、暂存路径、清单及总毫秒。返回：无。</summary>
    public static void Download(Uri endpoint, string token, string destination, Dictionary<string, object> manifest, int deadlineMilliseconds)
    {
        var request = QuotaPrototype.Request(endpoint, token); request.Method = "GET";
        using (var deadline = new Timer(delegate(object ignored) { request.Abort(); }, null, deadlineMilliseconds, Timeout.Infinite))
        using (var response = (HttpWebResponse)request.GetResponse()) { if (response.StatusCode != HttpStatusCode.OK) throw new InvalidOperationException("ota_download_status"); using (var stream = response.GetResponseStream()) CopyVerified(stream, destination, manifest); }
    }
    /// <summary>有界启动只读健康子进程；明确未创建进程时视为健康失败。参数：程序及根。返回：健康标记，清理不确定则抛异常保留证据。</summary>
    public static bool RunHealth(string executable, string root)
    {
        // 签名合法但不是 x64 PE 的文件不能交给系统加载器，避免旧式程序弹窗阻塞无人值守升级。
        using (var input = File.OpenRead(executable)) using (var reader = new BinaryReader(input)) {
            if (input.Length < 256 || reader.ReadUInt16() != 0x5a4d) return false; input.Position = 0x3c; uint offset = reader.ReadUInt32();
            if (offset > input.Length - 26) return false; input.Position = offset; if (reader.ReadUInt32() != 0x00004550 || reader.ReadUInt16() != 0x8664) return false; input.Position = offset + 24; if (reader.ReadUInt16() != 0x20b) return false;
        }
        Process child;
        try { child = Process.Start(new ProcessStartInfo(executable, "--ota-health-check --root \"" + root + "\"") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root }); }
        catch (Win32Exception) { return false; }
        using (child) { if (child == null) return false; if (!child.WaitForExit(30000)) { child.Kill(); if (!child.WaitForExit(5000)) throw new InvalidOperationException("ota_health_cleanup_unknown"); return false; } return child.ExitCode == 0; }
    }
    /// <summary>持久写入 OTA 日志。参数：根及完整记录。返回：无。</summary>
    public static void Save(string root, Dictionary<string, object> value) { QuotaClient.Atomic(root, PathIn(root, "ota/state.json"), Json.Serialize(value)); }
    /// <summary>尚未替换的已验签包过期时结束任务，保留最高序号。参数：根、日志、已验签清单及当前秒。返回：是否已结束。</summary>
    public static bool ExpireVerified(string root, Dictionary<string, object> state, Dictionary<string, object> manifest, long now)
    {
        if (QuotaClient.String(state, "phase") != "verified" || Convert.ToInt64(manifest["expires_at"]) > now) return false;
        state["error"] = "manifest_expired"; state["phase"] = "failed"; Save(root, state);
        string candidate = PathIn(root, "ota/candidate.exe"); if (File.Exists(candidate)) { if (Hash(candidate) != QuotaClient.String(manifest, "sha256")) throw new InvalidOperationException("ota_artifact_conflict"); File.Delete(candidate); } return true;
    }
    /// <summary>验证原始字节签名，再解析唯一扁平字段，防止解析器重复字段覆盖。参数：清单、签名、固定根、最低序号及当前秒。返回：严格清单。</summary>
    public static Dictionary<string, object> Verify(string manifest, string signature, Dictionary<string, object> trust, long floor, long now)
    {
        byte[] raw = new UTF8Encoding(false, true).GetBytes(manifest);
        if (raw.Length > 4096) throw new InvalidOperationException("ota_manifest_size");
        using (var rsa = new RSACryptoServiceProvider()) {
            rsa.PersistKeyInCsp = false;
            rsa.ImportParameters(new RSAParameters { Modulus = Convert.FromBase64String(QuotaClient.String(trust, "modulus")), Exponent = Convert.FromBase64String(QuotaClient.String(trust, "exponent")) });
            if (rsa.KeySize != 3072 || !rsa.VerifyData(raw, CryptoConfig.MapNameToOID("SHA256"), Convert.FromBase64String(signature))) throw new InvalidOperationException("ota_bad_signature");
        }
        // 签名不能替代结构验证；完整消费扁平 JSON，拒绝数组、嵌套、重复和不标准数字。
        const string str = "\"(?:[^\"\\\\\u0000-\u001f]|\\\\(?:[\"\\\\/bfnrt]|u[0-9a-fA-F]{4}))*\"";
        string pair = "(" + str + ")\\s*:\\s*(?:" + str + "|(?:0|[1-9][0-9]*))";
        if (!Regex.IsMatch(manifest, "\\A\\s*\\{\\s*(?:" + pair + "\\s*(?:,\\s*" + pair + "\\s*)*)?\\}\\s*\\z")) throw new InvalidOperationException("ota_bad_manifest");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match match in Regex.Matches(manifest, pair)) if (!seen.Add(Json.Deserialize<string>(match.Groups[1].Value))) throw new InvalidOperationException("ota_duplicate_field");
        var m = Json.Deserialize<Dictionary<string, object>>(manifest);
        string[] fields = { "protocol", "release_seq", "version", "platform", "min_updater", "filename", "sha256", "size", "issued_at", "expires_at", "key_id" };
        if (seen.Count != fields.Length) throw new InvalidOperationException("ota_bad_manifest");
        foreach (string name in fields) if (!seen.Contains(name)) throw new InvalidOperationException("ota_bad_manifest");
        foreach (string name in new[] { "protocol", "release_seq", "min_updater", "size", "issued_at", "expires_at" }) { if (!(m[name] is int || m[name] is long)) throw new InvalidOperationException("ota_bad_type"); QuotaClient.Integer(m[name], 0, 9007199254740991); }
        long seq = Convert.ToInt64(m["release_seq"]), size = Convert.ToInt64(m["size"]), issued = Convert.ToInt64(m["issued_at"]), expiry = Convert.ToInt64(m["expires_at"]);
        // 固定协议与平台，不允许清单协商算法或越过本地回滚保护。
        if (Convert.ToInt64(m["protocol"]) != 1 || Convert.ToInt64(m["min_updater"]) != 1 || seq <= floor || size < 1 || size > 20 * 1024 * 1024 || issued > now + 120 || expiry <= now || expiry <= issued || QuotaClient.String(m, "key_id") != QuotaClient.String(trust, "key_id") || QuotaClient.String(m, "platform") != "win-x64" || QuotaClient.String(m, "filename") != "CodexQuotaCollector.exe" || !Regex.IsMatch(QuotaClient.String(m, "sha256") ?? "", "\\A[a-f0-9]{64}\\z") || !Regex.IsMatch(QuotaClient.String(m, "version") ?? "", "\\A[0-9]+\\.[0-9]+\\.[0-9]+\\z")) throw new InvalidOperationException("ota_bad_manifest");
        return m;
    }
    /// <summary>流式校验包，超限立即停止。参数：输入流、目标路径及已验证清单。返回：无。</summary>
    public static void CopyVerified(Stream input, string destination, Dictionary<string, object> manifest)
    {
        long total = 0, expected = Convert.ToInt64(manifest["size"]); byte[] buffer = new byte[65536];
        try { using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            // 先检查总长度再写入，避免服务端 Content-Length 不可信时耗尽磁盘。
            int read; while ((read = input.Read(buffer, 0, buffer.Length)) > 0) { total += read; if (total > expected || total > 20 * 1024 * 1024) throw new InvalidOperationException("ota_artifact_size"); output.Write(buffer, 0, read); } output.Flush(true);
        } if (total != expected || Hash(destination) != QuotaClient.String(manifest, "sha256")) throw new InvalidOperationException("ota_artifact_hash"); }
        catch { if (File.Exists(destination)) File.Delete(destination); throw; }
    }
}

/// <summary>固定任务的 COM 边界，不修改现有采集任务。参数：私有根和固定任务名称。返回：快照或运行结果。</summary>
public static class OtaTasks
{
    /// <summary>读取已核验任务是否正在运行。参数：任务名与设备根。返回：实际运行标记。</summary>
    public static bool IsRunning(string name, string root)
    {
        object service = null, folder = null, task = null;
        try { service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")); Call(service, "Connect", BindingFlags.InvokeMethod); folder = Call(service, "GetFolder", BindingFlags.InvokeMethod, "\\"); task = Call(folder, "GetTask", BindingFlags.InvokeMethod, name); Validate(root, (string)Call(task, "Xml", BindingFlags.GetProperty), false); return Convert.ToInt32(Call(task, "State", BindingFlags.GetProperty)) == 4; }
        finally { foreach (object obj in new[] { task, folder, service }) if (obj != null && Marshal.IsComObject(obj)) Marshal.FinalReleaseComObject(obj); }
    }
    /// <summary>调用 COM。参数：对象、成员、类型及参数。返回：结果。</summary>
    private static object Call(object obj, string name, BindingFlags flags, params object[] args) { return obj.GetType().InvokeMember(name, flags, null, obj, args); }
    /// <summary>读取或运行已核验任务，始终释放 COM。参数：名称、根、是否升级器及是否运行。返回：完整任务 XML。</summary>
    public static string Access(string name, string root, bool updater, bool run)
    {
        object service = null, folder = null, task = null, running = null;
        try {
            service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")); Call(service, "Connect", BindingFlags.InvokeMethod);
            folder = Call(service, "GetFolder", BindingFlags.InvokeMethod, "\\"); task = Call(folder, "GetTask", BindingFlags.InvokeMethod, name);
            string xml = (string)Call(task, "Xml", BindingFlags.GetProperty); Validate(root, xml, updater);
            // 保持禁用任务的原状态，绝不通过 Run 绕过禁用策略。
            if (run && (bool)Call(task, "Enabled", BindingFlags.GetProperty)) running = Call(task, "Run", BindingFlags.InvokeMethod, (object)null);
            return xml;
        } finally { foreach (object obj in new[] { running, task, folder, service }) if (obj != null && Marshal.IsComObject(obj)) Marshal.FinalReleaseComObject(obj); }
    }
    /// <summary>检查任务唯一动作与同用户身份。参数：根、XML、是否升级器。返回：无。</summary>
    public static void Validate(string root, string xml, bool updater)
    {
        var doc = WindowsQuotaTaskStore.Parse(xml); var nodes = doc.SelectNodes("/*[local-name()='Task']/*[local-name()='Actions']/*");
        var principals = doc.SelectNodes("/*[local-name()='Task']/*[local-name()='Principals']/*");
        if (principals.Count != 1 || principals[0].LocalName != "Principal") throw new InvalidOperationException("ota_task_identity");
        var user = principals[0].SelectSingleNode("*[local-name()='UserId']"); var logon = principals[0].SelectSingleNode("*[local-name()='LogonType']");
        var actions = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Actions']"); var principalId = principals[0].Attributes["id"];
        var context = actions == null ? null : actions.Attributes["Context"]; var level = principals[0].SelectSingleNode("*[local-name()='RunLevel']");
        if (principalId == null || context == null || principalId.Value != context.Value || (updater && (level == null || level.InnerText != "LeastPrivilege"))) throw new InvalidOperationException("ota_task_identity");
        if (nodes.Count != 1 || nodes[0].LocalName != "Exec" || user == null || user.InnerText != WindowsIdentity.GetCurrent().User.Value || logon == null || (logon.InnerText != "S4U" && logon.InnerText != "InteractiveToken")) throw new InvalidOperationException("ota_task_identity");
        var command = nodes[0].SelectSingleNode("*[local-name()='Command']"); var arg = nodes[0].SelectSingleNode("*[local-name()='Arguments']");
        if (command == null || !String.Equals(command.InnerText, OtaCore.PathIn(root, updater ? "bin/CodexQuotaUpdater.exe" : "bin/CodexQuotaCollector.exe"), StringComparison.OrdinalIgnoreCase) || arg == null || (updater ? arg.InnerText != "--apply" : arg.InnerText != "--run" && arg.InnerText != "--resident")) throw new InvalidOperationException("ota_task_action");
    }
}
