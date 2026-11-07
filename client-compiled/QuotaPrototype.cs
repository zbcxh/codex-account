using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Threading;

/// <summary>约束本轮临时进程树的优先级与生命周期。参数：无。返回：可释放的独立 Job Object。</summary>
internal sealed class TemporaryProcessTree : IDisposable
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const uint JOB_OBJECT_LIMIT_PRIORITY_CLASS = 0x20;
    private readonly SafeFileHandle job;
    private bool attached;

    /// <summary>原生作业结构布局。参数：由封送器读取字段。返回：系统限制或活动进程统计。</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    /// <summary>原生作业结构布局。参数：由封送器读取字段。返回：系统限制或活动进程统计。</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    /// <summary>原生作业结构布局。参数：由封送器读取字段。返回：系统限制或活动进程统计。</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    /// <summary>创建独立作业，配置关闭即回收和低于正常的 CPU 优先级。</summary>
    /// <returns>新实例；系统不支持时抛出脱敏异常。</returns>
    public TemporaryProcessTree()
    {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid) { job.Dispose(); throw new InvalidOperationException("appserver_job_create_failed"); }
        var limits = new ExtendedLimits();
        limits.Basic.Flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PRIORITY_CLASS;
        limits.Basic.PriorityClass = 0x4000;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        {
            job.Dispose(); throw new InvalidOperationException("appserver_job_limits_failed");
        }
    }

    /// <summary>在发送初始化消息前绑定本轮进程，后续子进程自动继承约束。</summary>
    /// <param name="process">仅限本轮刚创建的 app-server。</param><returns>无；绑定失败则停止采集。</returns>
    public void Attach(Process process)
    {
        if (!AssignProcessToJobObject(job, process.Handle)) throw new InvalidOperationException("appserver_job_attach_failed");
        attached = true;
    }

    /// <summary>终止本作业内的全部进程，并在时限内确认无活动进程。</summary>
    /// <param name="timeout">等待退出的最大毫秒数。</param><returns>无；未确认回收时抛出脱敏异常。</returns>
    public void Stop(int timeout)
    {
        if (!attached) return;
        if (!TerminateJobObject(job, 1)) throw new InvalidOperationException("appserver_tree_stop_failed");
        var timer = Stopwatch.StartNew();
        // 主进程退出不代表子进程退出，必须读取作业内的活动进程数。
        while (true)
        {
            Accounting state;
            if (!QueryInformationJobObject(job, 1, out state, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                throw new InvalidOperationException("appserver_tree_query_failed");
            if (state.ActiveProcesses == 0) return;
            if (timer.ElapsedMilliseconds >= timeout) throw new InvalidOperationException("appserver_tree_exit_unconfirmed");
            Thread.Sleep(20);
        }
    }

    /// <summary>释放作业句柄，异常路径也由系统回收已绑定的进程树。</summary>
    /// <returns>无。</returns>
    public void Dispose() { job.Dispose(); }

    /// <summary>创建匿名作业。参数：安全属性、名称。返回：安全句柄。</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    /// <summary>设置作业限制。参数：作业、信息类型、限制、长度。返回：是否成功。</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits limits, uint length);
    /// <summary>绑定指定进程。参数：作业、进程句柄。返回：是否成功。</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    /// <summary>终止作业进程树。参数：作业、退出码。返回：是否成功。</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
    /// <summary>读取活动进程数。参数：作业、信息类型、结果、长度、可选返回长度。返回：是否成功。</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting data, uint length, IntPtr returned);
}



/// <summary>只读额度原型。参数：命令行选项。返回：脱敏结果或非零退出码；不接管现有采集任务。</summary>
public static class QuotaPrototype
{
    private const int MaxLine = 1048576;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxLine, RecursionLimit = 32 };

    /// <summary>创建有序添加字段的 JSON 对象。</summary>
    /// <param name="pairs">交替出现的字段名与值。</param><returns>字段字典。</returns>
    public static Dictionary<string, object> Obj(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i], pairs[i + 1]);
        return result;
    }

    /// <summary>安全获取嵌套字段，缺失时返回空值。</summary>
    /// <param name="value">起始对象。</param><param name="path">字段路径。</param><returns>字段值或空值。</returns>
    private static object Field(object value, params string[] path)
    {
        foreach (string name in path)
        {
            var map = value as Dictionary<string, object>;
            if (map == null || !map.TryGetValue(name, out value)) return null;
        }
        return value;
    }

    /// <summary>读取严格字符串字段，避免把其他类型误当身份信息。</summary>
    /// <param name="value">起始对象。</param><param name="path">字段路径。</param><returns>字符串或空值。</returns>
    private static string Text(object value, params string[] path) { return Field(value, path) as string; }

    /// <summary>读取有限数值，拒绝布尔、缺失、字符串和非有限值。</summary>
    /// <param name="value">JSON 数值。</param><returns>有限双精度值。</returns>
    private static double Number(object value)
    {
        if (!(value is int || value is long || value is decimal || value is double || value is float)) throw new InvalidOperationException("invalid_number");
        double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        if (Double.IsNaN(number) || Double.IsInfinity(number)) throw new InvalidOperationException("invalid_number");
        return number;
    }

    /// <summary>校验并转换额度窗口，拒绝缺失值冒充零。</summary>
    /// <param name="window">官方额度窗口。</param><param name="required">是否必须存在。</param><returns>现有服务端窗口结构或空值。</returns>
    private static object Window(object window, bool required)
    {
        if (window == null) { if (required) throw new InvalidOperationException("missing_primary"); return null; }
        double used = Number(Field(window, "usedPercent"));
        double minutes = Number(Field(window, "windowDurationMins"));
        if (used < 0 || used > 1000 || minutes <= 0 || minutes > 525600 || minutes != Math.Floor(minutes)) throw new InvalidOperationException("invalid_window");
        object resetValue = Field(window, "resetsAt");
        object reset = null;
        if (resetValue != null)
        {
            double seconds = Number(resetValue);
            if (seconds < 0 || seconds > 253402300799 || seconds != Math.Floor(seconds)) throw new InvalidOperationException("invalid_reset");
            reset = (long)seconds;
        }
        return Obj("used_percent", used, "window_minutes", (long)minutes, "resets_at", reset);
    }

    /// <summary>仅在查询前后身份与额度账号三方一致时构造现有上报格式。</summary>
    /// <param name="before">查询前身份。</param><param name="limits">额度响应。</param><param name="after">查询后身份。</param><param name="version">官方 CLI 版本。</param><returns>不含邮箱或凭据的上报对象，尚未发送。</returns>
    public static Dictionary<string, object> Normalize(object before, object limits, object after, string version)
    {
        string id = Text(before, "workspaceRouting", "chatgptAccountId");
        Guid parsed;
        // 保持原采集器的三方校验，拒绝切号中、缺少所属账号或类型异常的响应。
        if (Text(before, "account", "type") != "chatgpt" || Text(after, "account", "type") != "chatgpt" ||
            !Guid.TryParse(id, out parsed) || parsed == Guid.Empty ||
            !String.Equals(id, Text(after, "workspaceRouting", "chatgptAccountId"), StringComparison.Ordinal) ||
            !String.Equals(id, Text(limits, "accountId"), StringComparison.Ordinal) ||
            !String.Equals(Text(before, "account", "email"), Text(after, "account", "email"), StringComparison.Ordinal))
            throw new InvalidOperationException("ownership_mismatch");
        object limit = Field(limits, "rateLimitsByLimitId", "codex") ?? Field(limits, "rateLimits");
        if (Text(limit, "limitId") != "codex") throw new InvalidOperationException("wrong_product");
        object credits = Field(limit, "credits");
        if (credits != null)
        {
            if (!(Field(credits, "hasCredits") is bool) || !(Field(credits, "unlimited") is bool)) throw new InvalidOperationException("invalid_credits");
            credits = Obj("has_credits", Field(credits, "hasCredits"), "unlimited", Field(credits, "unlimited"), "balance", Field(credits, "balance"));
        }
        var report = Obj("source", "app_server", "collected_at", (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalSeconds,
            "account_id", id, "user_id", null, "plan_type", Field(before, "account", "planType"), "cli_version", version,
            "originator", "codex_quota_app_server", "primary", Window(Field(limit, "primary"), true),
            "secondary", Window(Field(limit, "secondary"), false), "credits", credits,
            "hit_limit", Field(limit, "rateLimitReachedType"), "source_seq", null, "last_session_mtime", null);
        // 原型不落队列；同一对象的事件 ID 在内存中生成一次，未来可交给可靠队列复用。
        using (var sha = SHA256.Create()) report.Add("event_id", BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Json.Serialize(report)))).Replace("-", "").ToLowerInvariant());
        return report;
    }

    /// <summary>验证可配置服务地址，禁止在 URL 中携带认证信息。</summary>
    /// <param name="server">HTTP 或 HTTPS 基础地址。</param><returns>沿用现有 /api/report 路径的地址。</returns>
    public static Uri Endpoint(string server)
    {
        Uri value;
        if (!Uri.TryCreate(server, UriKind.Absolute, out value) || (value.Scheme != "https" && value.Scheme != "http") ||
            value.UserInfo.Length != 0 || value.Query.Length != 0 || value.Fragment.Length != 0 || server.IndexOf('\\') >= 0)
            throw new InvalidOperationException("invalid_server");
        return new Uri(value.AbsoluteUri.TrimEnd('/') + "/api/report");
    }

    /// <summary>构造兼容现有服务端的请求，但本方法不联网。</summary>
    /// <param name="endpoint">上报地址。</param><param name="token">设备令牌；为空时构造不含认证头的迁移挑战。</param><returns>未发送的 POST 请求。</returns>
    public static HttpWebRequest Request(Uri endpoint, string token)
    {
        var request = (HttpWebRequest)WebRequest.Create(endpoint);
        request.Method = "POST";
        request.ContentType = "application/json; charset=utf-8";
        if (token != null) request.Headers["x-quota-token"] = token;
        // 不自动跟随重定向，防止将认证头转发到其他地址；证书使用系统默认验证。
        request.AllowAutoRedirect = false;
        request.Timeout = 10000;
        request.ReadWriteTimeout = 10000;
        request.MaximumResponseHeadersLength = 64;
        return request;
    }

    /// <summary>定位官方 CLI，不读取登录文件或会话目录。</summary>
    /// <param name="requested">可选的显式可执行文件路径。</param><returns>可执行文件绝对路径。</returns>
    public static string ResolveCodex(string requested)
    {
        if (requested != null)
        {
            if (!Path.IsPathRooted(requested) || !File.Exists(requested) || Path.GetExtension(requested).ToLowerInvariant() != ".exe") throw new InvalidOperationException("invalid_codex_path");
            return requested;
        }
        string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenAI", "Codex", "bin");
        string selected = null;
        DateTime newest = DateTime.MinValue;
        if (Directory.Exists(root)) foreach (string folder in Directory.EnumerateDirectories(root))
        {
            string path = Path.Combine(folder, "codex.exe");
            if (File.Exists(path) && File.GetLastWriteTimeUtc(path) > newest) { newest = File.GetLastWriteTimeUtc(path); selected = path; }
        }
        if (selected == null) throw new InvalidOperationException("codex_not_found");
        return selected;
    }

    /// <summary>读取匹配编号的只读 RPC 响应，限制消息长度和总等待时间。</summary>
    /// <param name="process">本次子进程。</param><param name="pending">跨消息保留的有界字符缓冲。</param><param name="clock">本轮总计时。</param><param name="timeout">总时限毫秒数。</param><param name="method">允许的只读方法。</param><param name="id">请求编号。</param><param name="parameters">请求参数。</param><returns>匹配的结果对象。</returns>
    private static object Rpc(Process process, StringBuilder pending, Stopwatch clock, int timeout, string method, int id, object parameters)
    {
        if (method != "initialize" && method != "account/read" && method != "account/rateLimits/read") throw new InvalidOperationException("non_readonly_method");
        string message = Json.Serialize(Obj("id", id, "method", method, "params", parameters));
        process.StandardInput.WriteLine(message);
        process.StandardInput.Flush();
        char[] chunk = new char[4096];
        while (true)
        {
            int remaining = timeout - (int)clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new InvalidOperationException("rpc_timeout");
            int newline = -1;
            for (int i = 0; i < pending.Length; i++) if (pending[i] == '\n') { newline = i; break; }
            if (newline >= 0)
            {
                string line = pending.ToString(0, newline);
                pending.Remove(0, newline + 1);
                if (line.Length > MaxLine) throw new InvalidOperationException("rpc_too_large");
                object response = Json.DeserializeObject(line);
                object responseId = Field(response, "id");
                if (responseId == null || Number(responseId) != id) continue;
                if (Field(response, "error") != null) throw new InvalidOperationException("rpc_error");
                return Field(response, "result");
            }
            // 先限制内存，再继续读取；错误流由独立固定缓冲任务排空，避免互相阻塞。
            if (pending.Length > MaxLine) throw new InvalidOperationException("rpc_too_large");
            Task<int> read = process.StandardOutput.ReadAsync(chunk, 0, Math.Min(chunk.Length, MaxLine + 1 - pending.Length));
            if (!read.Wait(remaining)) throw new InvalidOperationException("rpc_timeout");
            if (read.Result == 0) throw new InvalidOperationException("rpc_closed");
            pending.Append(chunk, 0, read.Result);
        }
    }

    /// <summary>查询并核验额度，只回收自身创建的临时 app-server。</summary>
    /// <param name="codex">官方可执行文件路径。</param><param name="timeout">本轮总超时。</param><returns>内存中的上报对象及性能信息。</returns>
    public static Dictionary<string, object> Collect(string codex, int timeout)
    {
        var info = new ProcessStartInfo(codex, "app-server --disable plugins") {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        using (var tree = new TemporaryProcessTree())
        using (var process = new Process { StartInfo = info })
        {
            bool started = false;
            var clock = Stopwatch.StartNew();
            Task drain = null;
            try
            {
                started = process.Start();
                if (!started) throw new InvalidOperationException("appserver_start_failed");
                // 先约束本轮进程树，再初始化；绑定失败不继续查询账号或额度。
                tree.Attach(process);
                drain = process.StandardError.BaseStream.CopyToAsync(Stream.Null, 4096);
                var pending = new StringBuilder();
                object init = Rpc(process, pending, clock, timeout, "initialize", 1, Obj("clientInfo", Obj("name", "codex_quota_monitor", "version", "2.0"), "capabilities", Obj("experimentalApi", true)));
                process.StandardInput.WriteLine("{\"method\":\"initialized\",\"params\":{}}"); process.StandardInput.Flush();
                object before = Rpc(process, pending, clock, timeout, "account/read", 2, Obj("refreshToken", false));
                object limits = Rpc(process, pending, clock, timeout, "account/rateLimits/read", 3, Obj());
                object after = Rpc(process, pending, clock, timeout, "account/read", 4, Obj("refreshToken", false));
                var report = Normalize(before, limits, after, Text(init, "userAgent"));
                process.Refresh();
                return Obj("report", report, "query_ms", clock.ElapsedMilliseconds,
                    "appserver_peak_mib", Math.Round(process.PeakWorkingSet64 / 1048576.0, 2), "appserver_cpu_ms", process.TotalProcessorTime.TotalMilliseconds);
            }
            finally
            {
                // 只处理已成功启动并持有句柄的自身子进程，不按进程名查杀桌面版。
                try
                {
                    if (started)
                    {
                        try { tree.Stop(5000); }
                        finally
                        {
                            // 绑定失败时作业尚不包含进程，仍需回收刚启动的主进程。
                            if (!process.HasExited) process.Kill();
                            if (!process.WaitForExit(5000)) throw new InvalidOperationException("appserver_exit_unconfirmed");
                        }
                    }
                }
                finally { if (drain != null) { try { drain.Wait(1000); } catch { } } }
            }
        }
    }

    /// <summary>返回合成测试用的固定账号和额度，完全不访问本机登录数据。</summary>
    /// <param name="kind">identity 或 limits。</param><returns>固定测试对象。</returns>
    public static object Fixture(string kind)
    {
        string id = "11111111-1111-1111-1111-111111111111";
        if (kind == "identity") return Obj("account", Obj("type", "chatgpt", "email", "fixture@example.invalid", "planType", "pro"), "workspaceRouting", Obj("chatgptAccountId", id));
        return Obj("accountId", id, "rateLimits", Obj("limitId", "codex", "primary", Obj("usedPercent", 23, "windowDurationMins", 300, "resetsAt", 1900000000L)));
    }

    /// <summary>断言不可信输入必须被拒绝。</summary>
    /// <param name="action">预期失败的操作。</param><returns>无，未拒绝时抛出异常。</returns>
    private static void Reject(Action action)
    {
        bool rejected = false;
        try { action(); } catch (InvalidOperationException) { rejected = true; }
        if (!rejected) throw new Exception("selftest_failed");
    }

    /// <summary>运行不读取本机状态、不联网的归属及边界回归。</summary>
    /// <returns>通过项数量。</returns>
    private static int SelfTest()
    {
        object before = Fixture("identity"), after = Fixture("identity"), limits = Fixture("limits");
        var report = Normalize(before, limits, after, "fixture");
        if ((double)Field(report, "primary", "used_percent") != 23 || Text(report, "event_id").Length != 64) throw new Exception("selftest_failed");
        ((Dictionary<string, object>)Field(after, "workspaceRouting"))["chatgptAccountId"] = "22222222-2222-2222-2222-222222222222";
        Reject(delegate { Normalize(before, limits, after, "fixture"); });
        after = Fixture("identity");
        ((Dictionary<string, object>)limits)["accountId"] = null;
        Reject(delegate { Normalize(before, limits, after, "fixture"); });
        limits = Fixture("limits");
        ((Dictionary<string, object>)limits)["accountId"] = "22222222-2222-2222-2222-222222222222";
        Reject(delegate { Normalize(before, limits, after, "fixture"); });
        limits = Fixture("limits");
        ((Dictionary<string, object>)Field(after, "account"))["email"] = "other@example.invalid";
        Reject(delegate { Normalize(before, limits, after, "fixture"); });
        after = Fixture("identity");
        foreach (object bad in new object[] { null, true, "23", -1, 1001, Double.NaN, Double.PositiveInfinity })
        {
            ((Dictionary<string, object>)Field(limits, "rateLimits", "primary"))["usedPercent"] = bad;
            Reject(delegate { Normalize(before, limits, after, "fixture"); });
        }
        limits = Fixture("limits");
        ((Dictionary<string, object>)Field(limits, "rateLimits"))["limitId"] = "other";
        Reject(delegate { Normalize(before, limits, after, "fixture"); });
        if (Endpoint("https://quota.example.invalid/base").AbsoluteUri != "https://quota.example.invalid/base/api/report") throw new Exception("selftest_failed");
        foreach (string bad in new[] { "file:///C:/quota", "https://user:secret@example.invalid", "https://example.invalid/?key=x", "https://example.invalid/#fragment" }) Reject(delegate { Endpoint(bad); });
        return 18;
    }

    /// <summary>仅向回环测试服务器发送合成数据，验证现有接口与 HTTPS。</summary>
    /// <param name="endpoint">必须为回环上报地址。</param><param name="certificate">可选合成测试证书，禁止用于真实采集。</param><returns>响应状态及确认字段。</returns>
    private static object TransportFixture(Uri endpoint, string certificate)
    {
        if (!endpoint.IsLoopback) throw new InvalidOperationException("fixture_requires_loopback");
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        var request = Request(endpoint, "fixture-token");
        if (certificate != null)
        {
            var expected = new X509Certificate2(certificate);
            // 合成回环测试允许固定证书，但仍拒绝主机名不匹配；不修改全局回调或系统证书信任。
            request.ServerCertificateValidationCallback = delegate(object sender, X509Certificate actual, X509Chain chain, SslPolicyErrors errors) {
                return actual != null && (errors & SslPolicyErrors.RemoteCertificateNameMismatch) == 0 && String.Equals(expected.Thumbprint, new X509Certificate2(actual).Thumbprint, StringComparison.OrdinalIgnoreCase);
            };
        }
        string body = Json.Serialize(Normalize(Fixture("identity"), Fixture("limits"), Fixture("identity"), "fixture"));
        byte[] bytes = Encoding.UTF8.GetBytes(body);
        request.ContentLength = bytes.Length;
        using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        using (var response = (HttpWebResponse)request.GetResponse())
        {
            if (response.StatusCode != HttpStatusCode.OK) throw new InvalidOperationException("fixture_bad_status");
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                char[] buffer = new char[65537];
                int total = 0, read;
                while (total < buffer.Length && (read = reader.Read(buffer, total, buffer.Length - total)) > 0) total += read;
                if (total > 65536) throw new InvalidOperationException("fixture_response_too_large");
                object decoded = Json.DeserializeObject(new string(buffer, 0, total));
                if (!Object.Equals(Field(decoded, "ok"), true)) throw new InvalidOperationException("fixture_not_acknowledged");
                return Obj("ok", true, "mode", "synthetic-loopback-transport", "status", (int)response.StatusCode, "reporting_config_received", Field(decoded, "reporting_config") != null);
            }
        }
    }

    /// <summary>执行独立原型，不提供真实上报、配对、任务修改或状态写入入口。</summary>
    /// <param name="args">只读查询或隔离测试选项。</param><returns>零表示成功，非零表示校验或查询失败。</returns>
    public static int Main(string[] args)
    {
        try
        {
            string server = null, codex = null, certificate = null;
            bool selfTest = false, transport = false;
            int timeout = 25000;
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--self-test") selfTest = true;
                else if (arg == "--fixture-transport") transport = true;
                else if (arg == "--server" && i + 1 < args.Length) server = args[++i];
                else if (arg == "--codex" && i + 1 < args.Length) codex = args[++i];
                else if (arg == "--fixture-cert" && i + 1 < args.Length) certificate = args[++i];
                else if (arg == "--timeout-ms" && i + 1 < args.Length) { if (!Int32.TryParse(args[++i], out timeout) || timeout < 100 || timeout > 25000) throw new InvalidOperationException("invalid_timeout"); }
                else if (arg == "--help") { Console.WriteLine("Read-only prototype: [--server https://host/base] [--codex C:\\path\\codex.exe] [--timeout-ms 25000]; --self-test; --fixture-transport --server LOOPBACK [--fixture-cert SYNTHETIC_CERT]"); return 0; }
                else throw new InvalidOperationException("invalid_option");
            }
            if (selfTest) { Console.WriteLine(Json.Serialize(Obj("ok", true, "tests", SelfTest()))); return 0; }
            Uri endpoint = server == null ? null : Endpoint(server);
            if (transport) { if (endpoint == null) throw new InvalidOperationException("missing_server"); Console.WriteLine(Json.Serialize(TransportFixture(endpoint, certificate))); return 0; }
            if (certificate != null) throw new InvalidOperationException("fixture_only_option");
            var clock = Stopwatch.StartNew();
            var result = Collect(ResolveCodex(codex), timeout);
            var report = (Dictionary<string, object>)result["report"];
            // 只构造请求说明，不获取配对令牌、不联网到服务端、不保存真实额度快照。
            string body = Json.Serialize(report);
            var current = Process.GetCurrentProcess(); current.Refresh();
            Console.WriteLine(Json.Serialize(Obj("ok", true, "mode", "read-only-prototype", "account_verified", true,
                "account_prefix", ((string)report["account_id"]).Substring(0, 8), "sent_report", false,
                "method", "POST", "path", "/api/report", "target", endpoint == null ? null : endpoint.AbsoluteUri,
                "payload_bytes", Encoding.UTF8.GetByteCount(body), "elapsed_ms", clock.ElapsedMilliseconds,
                "host_cpu_ms", current.TotalProcessorTime.TotalMilliseconds, "host_peak_mib", Math.Round(current.PeakWorkingSet64 / 1048576.0, 2),
                "appserver_cpu_ms", result["appserver_cpu_ms"], "appserver_peak_mib", result["appserver_peak_mib"])));
            return 0;
        }
        catch (Exception error)
        {
            // 仅输出预定义代码，避免异常消息带出原始 RPC、HTTP 响应、路径或凭据。
            string code = error is InvalidOperationException && System.Text.RegularExpressions.Regex.IsMatch(error.Message, "^[a-z_]+$") ? error.Message : "prototype_failed";
            Console.Error.WriteLine(Json.Serialize(Obj("ok", false, "error", code)));
            return 1;
        }
    }
}
