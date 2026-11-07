using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Xml;

/// <summary>任务实际状态。参数：由任务读取器填充。返回：保留完整 XML 的任务快照。</summary>
public sealed class QuotaTaskSnapshot
{
    public string Name;
    public string Path;
    public string Xml;
    public int Minutes;
}

/// <summary>可隔离测试的任务读写边界。参数：监控根目录及配置。返回：实际任务状态。</summary>
public interface IQuotaTaskStore
{
    /// <summary>只读获取已校验归属的任务。</summary><param name="root">监控目录。</param><param name="config">配置。</param><returns>实际任务。</returns>
    QuotaTaskSnapshot Read(string root, Dictionary<string, object> config);
    /// <summary>仅修改本监控任务的周期。</summary><param name="root">监控目录。</param><param name="config">配置。</param><param name="minutes">新周期。</param><returns>无。</returns>
    void SetMinutes(string root, Dictionary<string, object> config, int minutes);
}

/// <summary>使用 Task Scheduler COM，不加载 PowerShell。参数：无。返回：经归属校验的任务操作。</summary>
public sealed class WindowsQuotaTaskStore : IQuotaTaskStore
{
    /// <summary>调用 COM 方法或属性。</summary><param name="target">COM 对象。</param><param name="name">成员名。</param><param name="flags">调用类型。</param><param name="args">参数。</param><returns>COM 返回值。</returns>
    private static object Invoke(object target, string name, BindingFlags flags, params object[] args) { return target.GetType().InvokeMember(name, flags, null, target, args, CultureInfo.InvariantCulture); }
    /// <summary>释放本次持有的 COM 引用。</summary><param name="objects">引用集合。</param><returns>无。</returns>
    private static void Release(params object[] objects) { foreach (object item in objects) if (item != null && Marshal.IsComObject(item)) Marshal.FinalReleaseComObject(item); }
    /// <summary>以禁止 DTD 的方式解析任务 XML。</summary><param name="text">任务定义。</param><returns>XML 文档。</returns>
    public static XmlDocument Parse(string text)
    {
        if (text == null || text.Length > 262144) throw new InvalidOperationException("invalid_task_xml");
        var doc = new XmlDocument { PreserveWhitespace = true, XmlResolver = null };
        using (var reader = XmlReader.Create(new StringReader(text), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null })) doc.Load(reader);
        return doc;
    }
    /// <summary>校验单一动作、触发器和监控文件归属。</summary><param name="root">监控目录。</param><param name="text">任务 XML。</param><returns>实际周期。</returns>
    public static int Validate(string root, string text)
    {
        var doc = Parse(text);
        var actions = doc.SelectNodes("/*[local-name()='Task']/*[local-name()='Actions']/*");
        var triggers = doc.SelectNodes("/*[local-name()='Task']/*[local-name()='Triggers']/*");
        if (actions.Count != 1 || actions[0].LocalName != "Exec" || triggers.Count != 1 || triggers[0].LocalName != "TimeTrigger") throw new InvalidOperationException("task_not_owned");
        string command = actions[0].SelectSingleNode("*[local-name()='Command']").InnerText;
        var argNode = actions[0].SelectSingleNode("*[local-name()='Arguments']");
        string args = argNode == null ? "" : argNode.InnerText;
        string script = System.IO.Path.Combine(root, "bin", "Collect-CodexQuota.ps1");
        string executable = System.IO.Path.Combine(root, "bin", "CodexQuotaCollector.exe");
        // 只接受旧采集脚本或本目录编译客户端，避免服务端周期配置修改其他任务。
        bool old = String.Equals(System.IO.Path.GetFileName(command), "powershell.exe", StringComparison.OrdinalIgnoreCase) && Regex.IsMatch(args, "(?:^|\\s)-File\\s+\"?" + Regex.Escape(script) + "\"?(?:\\s|$)", RegexOptions.IgnoreCase);
        bool current = System.IO.Path.IsPathRooted(command) && String.Equals(System.IO.Path.GetFullPath(command), executable, StringComparison.OrdinalIgnoreCase) && args == "--run";
        if (!old && !current) throw new InvalidOperationException("task_not_owned");
        var interval = triggers[0].SelectSingleNode("*[local-name()='Repetition']/*[local-name()='Interval']");
        double minutes = interval == null ? 0 : XmlConvert.ToTimeSpan(interval.InnerText).TotalMinutes;
        if (minutes < 1 || minutes > 1440 || minutes != Math.Floor(minutes)) throw new InvalidOperationException("invalid_task_interval");
        return (int)minutes;
    }
    /// <summary>连接本地调度服务并读取指定任务。</summary><param name="root">监控目录。</param><param name="config">配置。</param><returns>归属核验后的任务快照。</returns>
    public QuotaTaskSnapshot Read(string root, Dictionary<string, object> config)
    {
        object service = null, folder = null, task = null;
        try
        {
            service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            Invoke(service, "Connect", BindingFlags.InvokeMethod);
            folder = Invoke(service, "GetFolder", BindingFlags.InvokeMethod, "\\");
            task = Invoke(folder, "GetTask", BindingFlags.InvokeMethod, QuotaClient.String(config, "task_name") ?? "CodexQuotaMonitor");
            string xml = (string)Invoke(task, "Xml", BindingFlags.GetProperty);
            return new QuotaTaskSnapshot { Name = (string)Invoke(task, "Name", BindingFlags.GetProperty), Path = (string)Invoke(task, "Path", BindingFlags.GetProperty), Xml = xml, Minutes = Validate(root, xml) };
        }
        finally { Release(task, folder, service); }
    }
    /// <summary>保持身份、权限和其他设置，仅更新触发周期并读回。</summary><param name="root">监控目录。</param><param name="config">配置。</param><param name="minutes">1 至 1440 的整分钟周期。</param><returns>无。</returns>
    public void SetMinutes(string root, Dictionary<string, object> config, int minutes)
    {
        if (minutes < 1 || minutes > 1440) throw new InvalidOperationException("invalid_task_interval");
        var snapshot = Read(root, config);
        var doc = Parse(snapshot.Xml);
        var repetition = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Triggers']/*/*[local-name()='Repetition']/*[local-name()='Interval']");
        var start = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Triggers']/*/*[local-name()='StartBoundary']");
        if (start == null) throw new InvalidOperationException("invalid_task_trigger");
        repetition.InnerText = "PT" + minutes + "M";
        start.InnerText = DateTime.Now.AddMinutes(minutes).ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);
        var principal = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Principals']/*");
        string user = principal.SelectSingleNode("*[local-name()='UserId']").InnerText;
        string logon = principal.SelectSingleNode("*[local-name()='LogonType']").InnerText;
        int logonType = logon == "S4U" ? 2 : logon == "InteractiveToken" ? 3 : 0;
        if (logonType == 0) throw new InvalidOperationException("unsupported_task_identity");
        object service = null, folder = null, task = null, updated = null;
        try
        {
            service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")); Invoke(service, "Connect", BindingFlags.InvokeMethod);
            string folderPath = snapshot.Path.Substring(0, snapshot.Path.LastIndexOf('\\') + 1);
            folder = Invoke(service, "GetFolder", BindingFlags.InvokeMethod, folderPath);
            task = Invoke(folder, "GetTask", BindingFlags.InvokeMethod, snapshot.Name);
            string security = (string)Invoke(task, "GetSecurityDescriptor", BindingFlags.InvokeMethod, 4);
            // 更新前再比较定义，避免用旧快照覆盖用户在本轮期间进行的任务修改。
            if ((string)Invoke(task, "Xml", BindingFlags.GetProperty) != snapshot.Xml) throw new InvalidOperationException("task_changed_concurrently");
            updated = Invoke(folder, "RegisterTask", BindingFlags.InvokeMethod, snapshot.Name, doc.OuterXml, 4, user, null, logonType, security);
        }
        finally { Release(updated, task, folder, service); }
        if (Read(root, config).Minutes != minutes) throw new InvalidOperationException("task_readback_mismatch");
    }
}

/// <summary>编译版日常采集器。参数：显式运行或只读模式。返回：脱敏状态，不实现登录或账号切换。</summary>
public static class QuotaClient
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 32 };
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    /// <summary>获取字符串配置。</summary><param name="map">字典。</param><param name="key">字段名。</param><returns>字符串或空值。</returns>
    public static string String(Dictionary<string, object> map, string key) { object value; return map.TryGetValue(key, out value) ? value as string : null; }
    /// <summary>获取可选字段。</summary><param name="map">字典。</param><param name="key">字段名。</param><returns>字段或空值。</returns>
    internal static object Get(Dictionary<string, object> map, string key) { object value; return map.TryGetValue(key, out value) ? value : null; }
    /// <summary>严格读取配置整数。</summary><param name="value">输入。</param><param name="min">下界。</param><param name="max">上界。</param><returns>整数。</returns>
    public static long Integer(object value, long min, long max)
    {
        if (!(value is int || value is long || value is decimal || value is double)) throw new InvalidOperationException("invalid_integer");
        double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        if (Double.IsNaN(number) || Double.IsInfinity(number) || number != Math.Floor(number) || number < min || number > max) throw new InvalidOperationException("invalid_integer");
        return (long)number;
    }
    /// <summary>比较不同 JSON 数值表示的相同整数，避免每轮重复写配置。</summary><param name="value">原值。</param><param name="expected">目标整数。</param><returns>是否相同。</returns>
    private static bool SameInteger(object value, long expected) { try { return Integer(value, 0, 9007199254740991) == expected; } catch { return false; } }
    /// <summary>防止状态路径越界或通过重解析点写入其他位置。</summary><param name="root">状态根目录。</param><param name="path">内部路径。</param><returns>规范化内部路径。</returns>
    public static string Fence(string root, string path)
    {
        string full = System.IO.Path.GetFullPath(path);
        string prefix = root.TrimEnd('\\') + "\\";
        if (!full.Equals(root, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("path_outside_state");
        string walk = full;
        while (walk != null)
        {
            if ((File.Exists(walk) || Directory.Exists(walk)) && (File.GetAttributes(walk) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("state_reparse_point");
            walk = System.IO.Path.GetDirectoryName(walk);
        }
        return full;
    }
    /// <summary>校验已有状态目录只授权当前用户、系统与管理员。</summary><param name="path">目录。</param><returns>无。</returns>
    public static void CheckPrivate(string path)
    {
        string current = WindowsIdentity.GetCurrent().User.Value;
        var acl = Directory.GetAccessControl(path);
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            string sid = rule.IdentityReference.Value;
            if (rule.AccessControlType != AccessControlType.Allow || (sid != current && sid != "S-1-5-18" && sid != "S-1-5-32-544")) throw new InvalidOperationException("state_permissions_not_private");
        }
    }
    /// <summary>只为新建子目录设置受限权限，已有目录只验证不改写。</summary><param name="root">状态根。</param><param name="path">内部目录。</param><returns>目录路径。</returns>
    public static string PrivateDirectory(string root, string path)
    {
        Fence(root, path);
        if (!Directory.Exists(path))
        {
            Directory.CreateDirectory(path);
            var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
            foreach (string sid in new[] { WindowsIdentity.GetCurrent().User.Value, "S-1-5-18", "S-1-5-32-544" })
                acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(path, acl);
        }
        CheckPrivate(path); return path;
    }
    /// <summary>有界读取 UTF-8 JSON 对象，不把损坏配置当成空配置继续写。</summary><param name="path">文件。</param><param name="optional">是否允许不存在。</param><returns>JSON 对象。</returns>
    public static Dictionary<string, object> Read(string path, bool optional)
    {
        if (!File.Exists(path)) { if (optional) return new Dictionary<string, object>(); throw new InvalidOperationException("state_file_missing"); }
        if (new FileInfo(path).Length > 1048576) throw new InvalidOperationException("state_file_too_large");
        var result = Json.DeserializeObject(File.ReadAllText(path, Utf8)) as Dictionary<string, object>;
        if (result == null) throw new InvalidOperationException("invalid_state_json");
        return result;
    }
    /// <summary>同目录持久化后原子替换，不暴露半写入队列或配置。</summary><param name="root">状态根。</param><param name="path">目标。</param><param name="text">内容。</param><returns>无。</returns>
    public static void Atomic(string root, string path, string text)
    {
        Fence(root, path);
        string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            byte[] bytes = Utf8.GetBytes(text);
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    /// <summary>兼容原有 DPAPI 双份令牌，优先机器范围；从不重写令牌。</summary><param name="root">监控目录。</param><returns>仅在内存中使用的上报令牌。</returns>
    public static string Token(string root)
    {
        foreach (string name in new[] { "token.lm.bin", "token.bin" })
        {
            string path = Fence(root, System.IO.Path.Combine(root, name));
            if (!File.Exists(path)) continue;
            if (new FileInfo(path).Length > 65536) throw new InvalidOperationException("invalid_token_blob");
            byte[] clear = null;
            try
            {
                clear = ProtectedData.Unprotect(File.ReadAllBytes(path), null, name == "token.lm.bin" ? DataProtectionScope.LocalMachine : DataProtectionScope.CurrentUser);
                string token = Utf8.GetString(clear);
                if (token.Length == 0 || token.Length > 4096 || token.IndexOfAny(new[] { '\r', '\n' }) >= 0) throw new InvalidOperationException("invalid_token");
                return token;
            }
            catch (CryptographicException) { }
            finally { if (clear != null) Array.Clear(clear, 0, clear.Length); }
        }
        throw new InvalidOperationException("paired_token_unavailable");
    }
    /// <summary>创建事件 ID，保持一次入队后可幂等重试。</summary><param name="report">快照对象。</param><returns>稳定事件 ID。</returns>
    public static string EventId(Dictionary<string, object> report)
    {
        report.Remove("event_id");
        using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Utf8.GetBytes(Json.Serialize(report)))).Replace("-", "").ToLowerInvariant();
    }
    /// <summary>返回有限容量队列文件；只在私有目录枚举。</summary><param name="root">状态目录。</param><returns>按文件名排序的队列。</returns>
    private static string[] Files(string root)
    {
        string spool = Fence(root, System.IO.Path.Combine(root, "spool"));
        if (!Directory.Exists(spool)) return new string[0];
        CheckPrivate(spool); string[] files = Directory.GetFiles(spool, "*.json"); Array.Sort(files, StringComparer.Ordinal); return files;
    }
    /// <summary>隔离保留旧来源队列，禁止再上报会话创建者身份。</summary><param name="root">状态目录。</param><returns>无。</returns>
    public static void QuarantineLegacy(string root)
    {
        foreach (string file in Files(root))
        {
            Fence(root, file);
            Dictionary<string, object> parsed = null;
            try { parsed = Read(file, false); } catch { }
            if (parsed != null && String(parsed, "source") == "app_server") continue;
            string quarantine = PrivateDirectory(root, System.IO.Path.Combine(root, "spool-unverified"));
            string target = System.IO.Path.Combine(quarantine, System.IO.Path.GetFileName(file));
            if (File.Exists(target)) target = System.IO.Path.Combine(quarantine, Guid.NewGuid().ToString("N") + "-" + System.IO.Path.GetFileName(file));
            File.Move(file, target);
        }
    }
    /// <summary>先可靠入队，满队列不删除历史数据。</summary><param name="root">状态目录。</param><param name="report">可信快照。</param><returns>已持久化文件路径。</returns>
    public static string Enqueue(string root, Dictionary<string, object> report)
    {
        string id = String(report, "event_id");
        if (id == null || !Regex.IsMatch(id, "^[a-f0-9]{64}$")) throw new InvalidOperationException("invalid_event_id");
        string spool = PrivateDirectory(root, System.IO.Path.Combine(root, "spool"));
        string path = Fence(root, System.IO.Path.Combine(spool, id + ".json"));
        if (File.Exists(path)) return path;
        if (Files(root).Length >= 72) throw new InvalidOperationException("queue_full");
        Atomic(root, path, Json.Serialize(report)); return path;
    }
    /// <summary>向现有接口提交一次，不自动重定向或无限重试。</summary><param name="endpoint">现有 API 地址。</param><param name="token">令牌。</param><param name="body">JSON 请求体。</param><returns>含成功状态和可选响应对象的结果。</returns>
    public static Dictionary<string, object> Post(Uri endpoint, string token, string body)
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        var request = QuotaPrototype.Request(endpoint, token);
        request.Timeout = 20000; request.ReadWriteTimeout = 20000;
        byte[] bytes = Utf8.GetBytes(body);
        try
        {
            request.ContentLength = bytes.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Utf8))
            {
                char[] chars = new char[65537]; int total = 0, got;
                while (total < chars.Length && (got = reader.Read(chars, total, chars.Length - total)) > 0) total += got;
                if (total > 65536) throw new InvalidOperationException("response_too_large");
                var decoded = Json.DeserializeObject(new string(chars, 0, total)) as Dictionary<string, object>;
                return QuotaPrototype.Obj("ok", response.StatusCode == HttpStatusCode.OK && decoded != null && Object.Equals(Get(decoded, "ok"), true), "status", (int)response.StatusCode, "data", decoded);
            }
        }
        catch (WebException error)
        {
            var response = error.Response as HttpWebResponse; int status = response == null ? 0 : (int)response.StatusCode;
            if (response != null) response.Dispose(); return QuotaPrototype.Obj("ok", false, "status", status, "data", null);
        }
    }
    /// <summary>读取真实任务周期，无法确认时不伪造。</summary><param name="root">状态根。</param><param name="config">配置。</param><param name="tasks">任务边界。</param><returns>实际周期确认或空值。</returns>
    public static Dictionary<string, object> Status(string root, Dictionary<string, object> config, IQuotaTaskStore tasks)
    {
        try { return QuotaPrototype.Obj("version", Integer(Get(config, "reporting_config_version") ?? 0, 0, 9007199254740991), "interval_minutes", tasks.Read(root, config).Minutes); }
        catch { return null; }
    }
    /// <summary>应用服务端周期、读回核验后仅更新配置确认字段。</summary><param name="root">状态目录。</param><param name="config">本轮配置。</param><param name="desired">服务端配置。</param><param name="tasks">任务边界。</param><returns>待回传确认，已确认相同配置时为空。</returns>
    public static Dictionary<string, object> Apply(string root, Dictionary<string, object> config, Dictionary<string, object> desired, IQuotaTaskStore tasks)
    {
        long minutes = Integer(Get(desired, "interval_minutes"), 1, 1440), version = Integer(Get(desired, "version"), 1, 9007199254740991);
        // 所有确认字段先校验，再考虑修改任务，避免在响应格式错误时发生部分更新。
        long? appliedVersion = Get(desired, "applied_version") == null ? (long?)null : Integer(Get(desired, "applied_version"), 0, 9007199254740991);
        long? appliedMinutes = Get(desired, "applied_interval_minutes") == null ? (long?)null : Integer(Get(desired, "applied_interval_minutes"), 1, 1440);
        int actual = tasks.Read(root, config).Minutes;
        if (actual != minutes) { tasks.SetMinutes(root, config, (int)minutes); actual = tasks.Read(root, config).Minutes; }
        if (actual != minutes) throw new InvalidOperationException("task_readback_mismatch");
        if (!SameInteger(Get(config, "reporting_config_version"), version) || !SameInteger(Get(config, "reporting_interval_minutes"), actual))
        {
            // 重新合并磁盘上的未知字段，绝不把本轮旧配置覆盖到用户刚改的其他设置上。
            string path = Fence(root, System.IO.Path.Combine(root, "config.json")); var fresh = Read(path, false);
            if (String(fresh, "client_id") != String(config, "client_id") || String(fresh, "task_name") != String(config, "task_name")) throw new InvalidOperationException("config_changed_concurrently");
            fresh["reporting_config_version"] = version; fresh["reporting_interval_minutes"] = actual;
            Atomic(root, path, Json.Serialize(fresh)); config["reporting_config_version"] = version; config["reporting_interval_minutes"] = actual;
        }
        if (appliedVersion == version && appliedMinutes == actual) return null;
        return QuotaPrototype.Obj("version", version, "interval_minutes", actual);
    }
    /// <summary>验证目标持有同一设备令牌并校验认证连接，成功后原子保存地址。</summary><param name="root">状态目录。</param><param name="config">当前配置。</param><param name="desired">迁移目标及版本。</param><param name="token">现有设备令牌。</param><returns>迁移确认；未设置目标时为空，失败不改本地地址。</returns>
    public static Dictionary<string, object> Migrate(string root, Dictionary<string, object> config, Dictionary<string, object> desired, string token)
    {
        string target = String(desired, "server_url");
        if (target == null) return null;
        long version = Integer(Get(desired, "version"), 1, 9007199254740991);
        var ack = QuotaPrototype.Obj("version", version, "server_url", target);
        try
        {
            Uri endpoint = QuotaPrototype.Endpoint(target);
            Uri current = QuotaPrototype.Endpoint(String(config, "server_url"));
            // HTTPS 不得被远程设置降级为明文 HTTP；新目标不能包含凭据或重定向。
            if (current.Scheme == "https" && endpoint.Scheme != "https") throw new InvalidOperationException("https_downgrade");
            if (current == endpoint && SameInteger(Get(desired, "applied_version"), version) && String(desired, "applied_url") == target) return null;
            string baseUri = endpoint.AbsoluteUri.Substring(0, endpoint.AbsoluteUri.Length - "report".Length);
            byte[] random = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(random);
            string nonce = BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
            string clientId = String(config, "client_id");
            var proofResponse = Post(new Uri(baseUri + "client/migration-proof"), null, Json.Serialize(QuotaPrototype.Obj("client_id", clientId, "nonce", nonce)));
            var proofData = Get(proofResponse, "data") as Dictionary<string, object>;
            string expected;
            using (var hmac = new HMACSHA256(Utf8.GetBytes(token))) expected = BitConverter.ToString(hmac.ComputeHash(Utf8.GetBytes("codex-quota-migration-v1\n" + clientId + "\n" + nonce))).Replace("-", "").ToLowerInvariant();
            if (!Object.Equals(Get(proofResponse, "ok"), true) || proofData == null || String(proofData, "client_id") != clientId || String(proofData, "proof") != expected) throw new InvalidOperationException("migration_proof_failed");
            var validation = Post(new Uri(baseUri + "client/migration-validate"), token, Json.Serialize(QuotaPrototype.Obj("client_id", clientId)));
            var validated = Get(validation, "data") as Dictionary<string, object>;
            if (!Object.Equals(Get(validation, "ok"), true) || validated == null || String(validated, "client_id") != clientId) throw new InvalidOperationException("migration_auth_failed");
            string path = Fence(root, System.IO.Path.Combine(root, "config.json")); var fresh = Read(path, false);
            // 只合并地址；本轮采集中若用户改过地址或身份，停止以免覆盖更新。
            if (String(fresh, "server_url") != String(config, "server_url") || String(fresh, "client_id") != clientId) throw new InvalidOperationException("config_changed_concurrently");
            if (current != endpoint) { fresh["server_url"] = target; Atomic(root, path, Json.Serialize(fresh)); config["server_url"] = target; }
        }
        catch { ack["error"] = "migration_validation_failed"; }
        return ack;
    }
    /// <summary>写入无凭据的本机轮转日志，日志故障不覆盖主流程结果。</summary><param name="root">状态目录。</param><param name="code">固定状态代码。</param><returns>无。</returns>
    internal static void Log(string root, string code)
    {
        try
        {
            string folder = PrivateDirectory(root, System.IO.Path.Combine(root, "logs")); string path = Fence(root, System.IO.Path.Combine(folder, "report.log"));
            string older = Fence(root, path + ".1");
            if (File.Exists(path) && new FileInfo(path).Length > 200000) { if (File.Exists(older)) File.Replace(path, older, null); else File.Move(path, older); }
            File.AppendAllText(path, DateTimeOffset.Now.ToString("o") + " compiled " + code + Environment.NewLine, Utf8);
        }
        catch { }
    }
    /// <summary>本轮身份核验后补传至多一条可信历史，满队列可先释放一个已确认槽位。</summary><param name="root">状态目录。</param><param name="endpoint">服务地址。</param><param name="token">上报令牌。</param><param name="now">本轮采集时间。</param><returns>是否已确认并移除一条历史；不应用历史响应中的配置。</returns>
    private static bool Drain(string root, Uri endpoint, string token, long now)
    {
        foreach (string path in Files(root))
        {
            Fence(root, path); var old = Read(path, false); string id = String(old, "event_id"); Guid account;
            // 保留无法核验的文件，拒绝通过畸形队列激活旧身份。
            if (String(old, "source") != "app_server" || id == null || !Regex.IsMatch(id, "^[a-f0-9]{64}$") || !Guid.TryParse(String(old, "account_id"), out account) || account == Guid.Empty) continue;
            long time = Integer(Get(old, "collected_at"), 0, 253402300799);
            if (time > now) continue;
            var response = Post(endpoint, token, Json.Serialize(old));
            if (!Object.Equals(Get(response, "ok"), true)) return false;
            File.Delete(path);
            return true;
        }
        return false;
    }
    /// <summary>运行完整日常流程；满队列在身份核验后先补传一条再可靠入队，失败保留全部历史。</summary><param name="root">状态目录。</param><param name="server">可选的本轮服务地址。</param><param name="codex">可选 CLI 路径。</param><param name="dry">只读模式，不触发状态写入或补传。</param><param name="tasks">任务边界。</param><returns>脱敏状态及退出码字段。</returns>
    public static Dictionary<string, object> Run(string root, string server, string codex, bool dry, IQuotaTaskStore tasks)
    {
        root = System.IO.Path.GetFullPath(root).TrimEnd('\\'); Fence(root, root);
        FileStream held = null;
        try
        {
            if (!dry)
            {
                if (!Directory.Exists(root)) throw new InvalidOperationException("state_directory_missing"); CheckPrivate(root);
                try { held = new FileStream(Fence(root, System.IO.Path.Combine(root, ".collector.lock")), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
                catch (IOException) { return QuotaPrototype.Obj("ok", true, "skipped", "collector_busy", "exit_code", 0); }
            }
            var config = Read(Fence(root, System.IO.Path.Combine(root, "config.json")), dry);
            Uri endpoint = QuotaPrototype.Endpoint(server ?? String(config, "server_url"));
            string token = dry ? null : Token(root);
            if (!dry) QuarantineLegacy(root);
            string executable = QuotaPrototype.ResolveCodex(codex ?? String(config, "codex_path"));
            var collected = QuotaPrototype.Collect(executable, 25000);
            var report = (Dictionary<string, object>)collected["report"];
            return ProcessReport(root, server, dry, tasks, config, endpoint, token, report);
        }
        finally
        {
            if (held != null) held.Dispose();
        }
    }
    /// <summary>在常驻生命周期锁内复用上报协议，不启动第二个官方进程。参数：状态根、已独立核验报告与内部定时器。返回：脱敏上报结果。</summary>
    internal static Dictionary<string, object> RunCollected(string root, Dictionary<string, object> report, IQuotaTaskStore tasks)
    {
        var config = Read(Fence(root, System.IO.Path.Combine(root, "config.json")), false);
        Uri endpoint = QuotaPrototype.Endpoint(String(config, "server_url"));
        string token = Token(root); QuarantineLegacy(root);
        return ProcessReport(root, null, false, tasks, config, endpoint, token, report);
    }
    /// <summary>在报告中附加采集器身份，并处理可靠队列、配置确认与迁移。参数：状态根、临时地址、只读标记、调度器、配置、地址、令牌和报告。返回：脱敏发送状态。</summary>
    private static Dictionary<string, object> ProcessReport(string root, string server, bool dry, IQuotaTaskStore tasks, Dictionary<string, object> config, Uri endpoint, string token, Dictionary<string, object> report)
    {
            // 入队前绑定当时实际运行的程序；历史补传保留原报告，不能冒充当前构建。
            foreach (var item in DescribeCollector()) report[item.Key] = item.Value;
            var status = Status(root, config, tasks); if (status != null) report["reporting_status"] = status;
            report["event_id"] = EventId(report);
            string prefix = String(report, "account_id").Substring(0, 8);
            if (dry) return QuotaPrototype.Obj("ok", true, "mode", "dry-run", "account_verified", true, "account_prefix", prefix, "sent_report", false, "exit_code", 0);
            bool recoveredSlot = false;
            // 已核验当前身份后才能恢复满队列；仅确认成功才移除旧事件，绝不丢弃历史或绕过新报告的可靠入队。
            if (Files(root).Length >= 72)
            {
                recoveredSlot = Drain(root, endpoint, token, Integer(Get(report, "collected_at"), 0, 253402300799));
                if (!recoveredSlot || Files(root).Length >= 72) throw new InvalidOperationException("queue_full");
            }
            string pending = Enqueue(root, report);
            var response = Post(endpoint, token, Json.Serialize(report));
            if (!Object.Equals(Get(response, "ok"), true))
            {
                Log(root, "report_queued_http_" + Get(response, "status"));
                return QuotaPrototype.Obj("ok", false, "queued", true, "http_status", Get(response, "status"), "exit_code", Object.Equals(Get(response, "status"), 401) ? 1 : 0);
            }
            File.Delete(pending); Log(root, "report_ok_account_" + prefix);
            var data = Get(response, "data") as Dictionary<string, object>;
            var desired = data == null ? null : Get(data, "reporting_config") as Dictionary<string, object>;
            if (desired != null)
            {
                Dictionary<string, object> ack = null;
                try { ack = Apply(root, config, desired, tasks); }
                catch
                {
                    Log(root, "schedule_update_failed"); var actual = Status(root, config, tasks);
                    if (actual != null) ack = QuotaPrototype.Obj("version", Get(desired, "version"), "interval_minutes", Get(actual, "interval_minutes"), "error", "schedule_update_failed");
                }
                if (ack != null)
                {
                    var ackEndpoint = new Uri(endpoint.AbsoluteUri.Substring(0, endpoint.AbsoluteUri.Length - "report".Length) + "client/reporting-ack");
                    if (!Object.Equals(Get(Post(ackEndpoint, token, Json.Serialize(ack)), "ok"), true)) { Log(root, "ack_pending"); }
                }
            }
            var migration = data == null ? null : Get(data, "migration_config") as Dictionary<string, object>;
            if (migration != null && server == null)
            {
                var migrationAck = Migrate(root, config, migration, token);
                if (migrationAck != null)
                {
                    Log(root, Get(migrationAck, "error") == null ? "migration_applied" : "migration_validation_failed");
                    var migrationEndpoint = new Uri(endpoint.AbsoluteUri.Substring(0, endpoint.AbsoluteUri.Length - "report".Length) + "client/migration-ack");
                    if (!Object.Equals(Get(Post(migrationEndpoint, token, Json.Serialize(migrationAck)), "ok"), true)) Log(root, "migration_ack_pending");
                }
            }
            // 满队列已补传过一条，本轮不再额外排空，保持每轮最多一次历史重试。
            if (!recoveredSlot) Drain(root, endpoint, token, Integer(Get(report, "collected_at"), 0, 253402300799));
            // 只有本轮实时上报成功且未发生地址切换才检查OTA；历史补传及重放响应不触发执行。
            if (server == null && !Object.Equals(Get(data, "replay"), true) && (migration == null || String(migration, "server_url") == null)) OtaClient.PollAfterCurrentReport(root, config);
            return QuotaPrototype.Obj("ok", true, "account_verified", true, "account_prefix", prefix, "sent_report", true, "exit_code", 0);
    }
    private static readonly Lazy<Dictionary<string, object>> CollectorMetadata = new Lazy<Dictionary<string, object>>(ReadCollectorMetadata);
    /// <summary>读取采集器程序集自身的构建标识和程序摘要；参数：无。返回：未知项为空值的元数据。</summary>
    private static Dictionary<string, object> ReadCollectorMetadata()
    {
        var assembly = typeof(QuotaClient).Assembly;
        var attribute = (AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(assembly, typeof(AssemblyInformationalVersionAttribute));
        string version = null, build = null, digest = null;
        if (attribute != null)
        {
            string[] parts = attribute.InformationalVersion.Split(new char[] { '+' }, 2);
            version = parts[0]; build = parts.Length == 2 ? parts[1] : null;
        }
        // 每个进程只读取一次自身文件；无法读取时保持未知，不阻止正常额度上报。
        try { using (var stream = File.OpenRead(assembly.Location)) using (var sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return QuotaPrototype.Obj("collector_version", version, "collector_build", build, "collector_sha256", digest);
    }
    /// <summary>返回采集器自身元数据副本，供正常上报及无副作用构建验证使用；参数：无。返回：版本、构建编号和SHA-256。</summary>
    public static Dictionary<string, object> DescribeCollector()
    {
        return new Dictionary<string, object>(CollectorMetadata.Value);
    }
    /// <summary>显式选择只读、单轮或常驻运行，禁止隐式配对与登录。</summary><param name="args">命令行选项；常驻资源参数仅本机可设。</param><returns>兼容任务计划的退出码，二表示常驻暂停。</returns>
    public static int Main(string[] args)
    {
        string root = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexQuota"), server = null, codex = null;
        bool run = false, dry = false, resident = false, resume = false, executionStarted = false, otaHealth = false;
        int cpuPercent = 5; bool cpuSpecified = false;
        try
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--run") run = true;
                else if (args[i] == "--resident") resident = true;
                else if (args[i] == "--resume") resume = true;
                else if (args[i] == "--cpu-percent" && i + 1 < args.Length) { cpuPercent = Int32.Parse(args[++i], CultureInfo.InvariantCulture); cpuSpecified = true; }
                else if (args[i] == "--dry-run") dry = true;
                else if (args[i] == "--ota-health-check") otaHealth = true;
                else if (args[i] == "--root" && i + 1 < args.Length) root = args[++i];
                else if (args[i] == "--state-dir" && i + 1 < args.Length) root = args[++i];
                else if (args[i] == "--server" && i + 1 < args.Length) server = args[++i];
                else if (args[i] == "--codex" && i + 1 < args.Length) codex = args[++i];
                else if (args[i] == "--help") { Console.WriteLine("CodexQuotaCollector --dry-run|--run|--resident [--state-dir PATH] [--codex PATH]; resident: [--cpu-percent 1..10] [--resume]"); return 0; }
                else throw new InvalidOperationException("invalid_option");
            }
            if (otaHealth) {
                if (run || dry || resident || resume || cpuSpecified || server != null || codex != null) throw new InvalidOperationException("invalid_ota_health_options");
                Console.WriteLine(Json.Serialize(OtaClient.HealthCheck(root))); return 0;
            }
            if ((run ? 1 : 0) + (dry ? 1 : 0) + (resident ? 1 : 0) != 1) throw new InvalidOperationException("select_run_or_dry_run");
            if ((!resident && (resume || cpuSpecified)) || (resident && server != null)) throw new InvalidOperationException("invalid_resident_options");
            executionStarted = true;
            // 升级器退出之前不启动官方进程，避免替换窗口与冷启动资源叠加。
            if (!dry) OtaClient.WaitForUpdater(root);
            Dictionary<string, object> result;
            if (resident) {
                using (var stop = new System.Threading.ManualResetEvent(false)) {
                    // 控制台退出只请求协作停止；计划任务强制结束仍由作业句柄关闭回收官方树。
                    ConsoleCancelEventHandler cancel = delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; stop.Set(); };
                    Console.CancelKeyPress += cancel;
                    try { result = ResidentCollector.Run(root, codex, cpuPercent, resume, stop); }
                    finally { Console.CancelKeyPress -= cancel; }
                }
            } else result = Run(root, server, codex, dry, new WindowsQuotaTaskStore());
            Console.WriteLine(Json.Serialize(result)); return Convert.ToInt32(result["exit_code"], CultureInfo.InvariantCulture);
        }
        catch (Exception error)
        {
            string code = error is InvalidOperationException && Regex.IsMatch(error.Message, "^[a-z_]+$") ? error.Message : "collector_failed";
            if (executionStarted && (run || resident) && Directory.Exists(root)) { try { Fence(root, root); CheckPrivate(root); Log(root, "error_" + code); } catch { } }
            Console.Error.WriteLine(Json.Serialize(QuotaPrototype.Obj("ok", false, "error", code))); return 1;
        }
    }
}
