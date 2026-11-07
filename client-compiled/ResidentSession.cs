using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

/// <summary>可注入的常驻只读采集会话。参数：由工厂创建。返回：核验报告与故障事件。</summary>
public interface IResidentSession : IDisposable
{
    /// <summary>重新校验当前账号并采集额度。参数：无。返回：未发送的核验报告。</summary>
    Dictionary<string, object> Collect();
    WaitHandle Faulted { get; }
}

/// <summary>持续排空有界标准流并复用唯一官方会话。参数：程序、预算及超时。返回：独立校验的报告。</summary>
public sealed class ResidentSession : IResidentSession
{
    private readonly ResidentProcess process;
    private readonly ResidentBudget budget;
    private readonly int queryTimeout;
    private readonly object gate = new object();
    private readonly AutoResetEvent ready = new AutoResetEvent(false);
    private readonly ManualResetEvent failed = new ManualResetEvent(false), stopping = new ManualResetEvent(false);
    private Thread reader, errors, monitor;
    private long nextId, expected;
    private object result;
    private string failure, version;
    private bool responseReady, disposed;
    public int RequestCount { get; private set; }
    public WaitHandle Faulted { get { return failed; } }
    /// <summary>建立资源受限会话，初始化并在期限内进入稳定预算。参数：可执行路径、预算、启动和查询超时、收敛毫秒。返回：会话。</summary>
    public ResidentSession(string executable, ResidentBudget budget, int startupTimeout, int queryTimeout, int settleTimeout) {
        if (budget == null || startupTimeout < 1 || queryTimeout < 1 || settleTimeout < 1) throw new InvalidOperationException("invalid_resident_options");
        this.budget = budget; this.queryTimeout = queryTimeout;
        var clock = Stopwatch.StartNew();
        try {
            budget.EnterStartup(); process = new ResidentProcess(executable, budget);
            reader = Background(ReadOutput); errors = Background(ReadErrors); monitor = Background(Monitor);
            var init = Request("initialize", QuotaPrototype.Obj("clientInfo", QuotaPrototype.Obj("name", "codex_quota_monitor", "version", "3.0"), "capabilities", QuotaPrototype.Obj("experimentalApi", true)), startupTimeout);
            version = QuotaClient.String(init as Dictionary<string, object>, "userAgent");
            process.Input.WriteLine("{\"method\":\"initialized\",\"params\":{}}");
            long deadline = Math.Min(startupTimeout, clock.ElapsedMilliseconds + settleTimeout);
            // 初始化可能暂时保留缓存；只允许在启动预算内有限等待，不通过清空工作集伪装。
            while (budget.Snapshot().PrivateBytes >= 200L * 1048576) {
                if (clock.ElapsedMilliseconds >= deadline) throw new InvalidOperationException("steady_memory_exceeded");
                if (failed.WaitOne(250)) ThrowFailure();
            }
            if (clock.ElapsedMilliseconds >= startupTimeout) throw new InvalidOperationException("rpc_timeout");
            budget.EnterSteady();
        } catch { Dispose(); throw; }
    }
    /// <summary>创建后台排空或监测线程。参数：入口。返回：已启动线程。</summary>
    private static Thread Background(ThreadStart action) { var thread = new Thread(action) { IsBackground = true }; thread.Start(); return thread; }
    /// <summary>原子记录首个脱敏故障并唤醒等待者。参数：固定错误码。返回：无。</summary>
    private void Fail(string code) { lock (gate) { if (failure == null) failure = code; } failed.Set(); ready.Set(); }
    /// <summary>发现故障时拒绝继续会话。参数：无。返回：无或异常。</summary>
    private void ThrowFailure() { lock (gate) { if (failure != null) throw new InvalidOperationException(failure); if (disposed) throw new InvalidOperationException("rpc_closed"); } }
    /// <summary>持续解析有限行，通知和无关响应不占待处理队列。参数：无。返回：无。</summary>
    private void ReadOutput() {
        try {
            var json = new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 32 };
            var line = new StringBuilder(); var block = new char[4096]; int count;
            while ((count = process.Output.Read(block, 0, block.Length)) != 0) {
                // 固定读取块与一 MiB 单行边界同时限制空闲通知和异常进程输出。
                for (int i = 0; i < count; i++) {
                    if (block[i] != '\n') { if (line.Length >= 1048576) throw new InvalidOperationException("rpc_too_large"); line.Append(block[i]); continue; }
                    var response = json.DeserializeObject(line.ToString()) as Dictionary<string, object>; line.Length = 0;
                    if (response == null) throw new InvalidOperationException("rpc_invalid_json");
                    object id = QuotaClient.Get(response, "id");
                    if (id == null) continue;
                    if (!(id is int || id is long)) throw new InvalidOperationException("rpc_invalid_id");
                    lock (gate) {
                        if (Convert.ToInt64(id) != expected || expected == 0 || responseReady) continue;
                        if (QuotaClient.Get(response, "error") != null) { Fail("rpc_error"); continue; }
                        result = QuotaClient.Get(response, "result"); responseReady = true; ready.Set();
                    }
                }
            }
            if (!stopping.WaitOne(0)) Fail("rpc_closed");
        } catch { if (!stopping.WaitOne(0)) Fail("rpc_output_failed"); }
    }
    /// <summary>独立固定缓冲排空错误流，不缓存官方日志。参数：无。返回：无。</summary>
    private void ReadErrors() {
        try { var block = new byte[4096]; while (process.Error.Read(block, 0, block.Length) != 0) { } }
        catch { if (!stopping.WaitOne(0)) Fail("rpc_error_stream_failed"); }
    }
    /// <summary>每秒核验总资源状态，空闲时阻塞等待事件。参数：无。返回：无。</summary>
    private void Monitor() {
        try {
            while (!stopping.WaitOne(1000)) {
                var usage = budget.Snapshot();
                if (usage.PrivateBytes > budget.MemoryLimitMiB * 1048576L) { Fail("memory_exceeded"); return; }
            }
        } catch { if (!stopping.WaitOne(0)) Fail("resource_state_unknown"); }
    }
    /// <summary>发送唯一编号的白名单请求，超时污染的会话不可复用。参数：方法、参数和本次超时。返回：匹配结果。</summary>
    private object Request(string method, object parameters, int timeout) {
        if (method != "initialize" && method != "account/read" && method != "account/rateLimits/read") throw new InvalidOperationException("non_readonly_method");
        ThrowFailure();
        lock (gate) {
            if (expected != 0 || nextId >= 1000000000) throw new InvalidOperationException("rpc_request_conflict");
            expected = ++nextId; responseReady = false; result = null; RequestCount++;
        }
        try {
            var json = new JavaScriptSerializer();
            var clock = Stopwatch.StartNew();
            // 写管道也纳入同一超时，防止异常服务停止读取 stdin 却继续输出时卡住控制进程。
            var write = process.Input.WriteLineAsync(json.Serialize(QuotaPrototype.Obj("id", expected, "method", method, "params", parameters)));
            write.ContinueWith(delegate(Task completed) { var observed = completed.Exception; }, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
            if (!write.Wait(timeout)) { Fail("rpc_timeout"); ThrowFailure(); }
            while (true) {
                ThrowFailure();
                lock (gate) { if (responseReady) return result; }
                int remaining = timeout - (int)clock.ElapsedMilliseconds;
                if (remaining <= 0 || !ready.WaitOne(remaining)) { Fail("rpc_timeout"); ThrowFailure(); }
            }
        } catch { Fail("rpc_failed"); ThrowFailure(); throw; }
        finally { lock (gate) { expected = 0; result = null; responseReady = false; } }
    }
    /// <summary>每轮独立读取前身份、额度、后身份，不缓存账号结论。参数：无。返回：核验报告。</summary>
    public Dictionary<string, object> Collect() {
        var clock = Stopwatch.StartNew();
        try {
            object before = Request("account/read", QuotaPrototype.Obj("refreshToken", false), queryTimeout);
            int remaining = queryTimeout - (int)clock.ElapsedMilliseconds; if (remaining < 1) throw new InvalidOperationException("rpc_timeout");
            object limits = Request("account/rateLimits/read", QuotaPrototype.Obj(), remaining);
            remaining = queryTimeout - (int)clock.ElapsedMilliseconds; if (remaining < 1) throw new InvalidOperationException("rpc_timeout");
            object after = Request("account/read", QuotaPrototype.Obj("refreshToken", false), remaining);
            return QuotaPrototype.Normalize(before, limits, after, version);
        } catch { Fail("collection_failed"); throw; }
    }
    /// <summary>唤醒后台线程并只回收自有会话树，停止后不保留响应。参数：无。返回：无。</summary>
    public void Dispose() {
        lock (gate) { if (disposed) return; disposed = true; }
        stopping.Set(); failed.Set(); ready.Set();
        bool cleaned = true;
        try { if (process != null) process.Dispose(); } catch { cleaned = false; }
        foreach (var thread in new[] { reader, errors, monitor }) if (thread != null && thread != Thread.CurrentThread) thread.Join(5000);
        // 未结束线程仍可能引用等待句柄；正常会话终止后才能释放，防止后台异常逃逸。
        bool ended = (reader == null || !reader.IsAlive) && (errors == null || !errors.IsAlive) && (monitor == null || !monitor.IsAlive);
        if (ended) { ready.Dispose(); failed.Dispose(); stopping.Dispose(); }
        if (!cleaned || !ended) throw new InvalidOperationException("process_tree_cleanup_failed");
    }
}
