using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Security.Principal;

/// <summary>低配常驻合成测试入口，不访问真实账号或服务。参数：测试场景或合成子进程参数。返回：测试退出码。</summary>
public static class ResidentTests
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    /// <summary>交叉采样实际进程私有提交，与内核历史计费峰值分开。参数：自有预算及是否启用。返回：最大实际样本。</summary>
    private sealed class MemoryProbe : IDisposable {
        private readonly ManualResetEvent stop = new ManualResetEvent(false); private Thread thread; private long maximum;
        public long Maximum { get { return Interlocked.Read(ref maximum); } }
        /// <summary>仅内存压力场景启动采样。参数：预算及开关。返回：探针。</summary>
        internal MemoryProbe(ResidentBudget budget, bool enabled) {
            if (!enabled) return;
            thread = new Thread(delegate() {
                while (!stop.WaitOne(1)) {
                    try { long value = budget.Snapshot().PrivateBytes; if (value > maximum) Interlocked.Exchange(ref maximum, value); }
                    catch { /* 合成进程退出与采样可能竞态，测试不把未知样本伪造为零。 */ }
                }
            }) { IsBackground = true }; thread.Start();
        }
        /// <summary>结束采样并释放等待句柄。参数：无。返回：无。</summary>
        public void Dispose() { stop.Set(); if (thread != null) thread.Join(5000); stop.Dispose(); }
    }
    /// <summary>断言测试事实。参数：条件与错误码。返回：无，失败抛异常。</summary>
    private static void Check(bool value, string code) { if (!value) throw new Exception(code); }
    /// <summary>模拟整树清理状态无法确认。参数：真实合成会话。返回：故障注入包装器。</summary>
    private sealed class UncertainCleanup : IResidentSession {
        private readonly IResidentSession inner;
        /// <summary>包装合成会话。参数：会话。返回：包装实例。</summary>
        internal UncertainCleanup(IResidentSession inner) { this.inner = inner; }
        public WaitHandle Faulted { get { return inner.Faulted; } }
        /// <summary>代理合成查询。参数：无。返回：报告。</summary>
        public Dictionary<string, object> Collect() { return inner.Collect(); }
        /// <summary>真实合成进程回收后注入未知状态。参数：无。返回：固定异常。</summary>
        public void Dispose() { inner.Dispose(); throw new InvalidOperationException("process_tree_cleanup_failed"); }
    }
    /// <summary>模拟首轮成功但立即空闲故障的会话。参数：合成会话。返回：早退事件包装器。</summary>
    private sealed class EarlyFault : IResidentSession {
        private readonly IResidentSession inner; private readonly ManualResetEvent fault = new ManualResetEvent(true);
        /// <summary>包装合成会话。参数：会话。返回：包装实例。</summary>
        internal EarlyFault(IResidentSession inner) { this.inner = inner; }
        public WaitHandle Faulted { get { return fault; } }
        /// <summary>代理单轮报告。参数：无。返回：核验报告。</summary>
        public Dictionary<string, object> Collect() { return inner.Collect(); }
        /// <summary>释放合成会话和事件。参数：无。返回：无。</summary>
        public void Dispose() { inner.Dispose(); fault.Dispose(); }
    }
    /// <summary>模拟官方只读服务。参数：无。返回：合成进程退出码。</summary>
    private static int Fake()
    {
        string mode = Environment.GetEnvironmentVariable("RESIDENT_FIXTURE_MODE") ?? "reuse";
        var held = new List<byte[]>();
        if (mode == "cannot-settle") {
            // 保持启动预算内但超过稳定预算，必须在收敛期限届满后失败而非偷偷提高限制。
            for (int i = 0; i < 26; i++) { var b = new byte[8 * 1048576]; for (int n = 0; n < b.Length; n += 4096) b[n] = 1; held.Add(b); }
        }
        if (mode == "tree") {
            var child = Process.Start(new ProcessStartInfo(typeof(ResidentTests).Assembly.Location, "fixture-child") { UseShellExecute = false, CreateNoWindow = true });
            File.WriteAllText(Environment.GetEnvironmentVariable("RESIDENT_FIXTURE_CHILD"), child.Id.ToString()); child.Dispose();
        }
        if (mode == "cpu") {
            // 合成忙线程只在自有作业中运行，核验硬限额对控制进程和工作线程合计生效。
            for (int i = 0; i < Math.Min(Environment.ProcessorCount, 64); i++) new Thread(delegate() { while (true) Thread.SpinWait(1000); }) { IsBackground = true }.Start();
        }
        if (mode == "startup-memory") {
            // 分块触碰真实内存，验证总提交限制，而非仅保留虚拟地址。
            try { for (int i = 0; i < 100; i++) { var b = new byte[8 * 1048576]; for (int n = 0; n < b.Length; n += 4096) b[n] = 1; held.Add(b); } }
            catch (OutOfMemoryException) { return 3; }
        }
        string line; int calls = 0;
        var seen = new HashSet<int>();
        while ((line = Console.ReadLine()) != null) {
            var request = Json.DeserializeObject(line) as Dictionary<string, object>;
            if (!request.ContainsKey("id")) continue;
            int id = Convert.ToInt32(request["id"]); string method = (string)request["method"];
            if (!seen.Add(id)) return 4;
            if (method == "initialize") {
                string audit = Environment.GetEnvironmentVariable("RESIDENT_FIXTURE_AUDIT");
                if (audit != null) File.AppendAllText(audit, "initialize\n");
            }
            if (mode == "timeout" && method == "account/read") { Thread.Sleep(10000); continue; }
            if (mode == "closed" && method != "initialize") return 0;
            if (mode == "steady-memory" && method != "initialize") {
                try { while (true) { var block = new byte[8 * 1048576]; for (int n = 0; n < block.Length; n += 4096) block[n] = 1; held.Add(block); File.WriteAllText(Environment.GetEnvironmentVariable("RESIDENT_FIXTURE_CHILD"), Process.GetCurrentProcess().PrivateMemorySize64.ToString()); Thread.Sleep(10); } }
                catch (OutOfMemoryException) { return 3; }
            }
            // 通知及无关响应不能被误认成当前请求；大量错误流不得阻塞。
            Console.WriteLine("{\"method\":\"fixture/notification\",\"params\":{}}");
            Console.WriteLine("{\"id\":999999,\"result\":{}}");
            if (mode == "burst") { Console.Error.Write(new string('x', 1048576)); Console.Error.Flush(); }
            string body;
            if (method == "initialize") body = "{\"userAgent\":\"resident-fixture\"}";
            else if (method == "account/rateLimits/read") body = "{\"accountId\":\"11111111-1111-1111-1111-111111111111\",\"rateLimits\":{\"limitId\":\"codex\",\"primary\":{\"usedPercent\":23,\"windowDurationMins\":300,\"resetsAt\":1900000000}}}";
            else { calls++; string account = mode == "mismatch" && calls % 2 == 0 ? "22222222-2222-2222-2222-222222222222" : "11111111-1111-1111-1111-111111111111";
                body = "{\"account\":{\"type\":\"chatgpt\",\"email\":\"fixture@example.invalid\",\"planType\":\"pro\"},\"workspaceRouting\":{\"chatgptAccountId\":\"" + account + "\"}}"; }
            if (mode == "oversize" && method != "initialize") Console.WriteLine(new string('x', 1048577));
            else Console.WriteLine("{\"id\":" + id + ",\"result\":" + body + "}");
            Console.Out.Flush();
        }
        return 0;
    }
    /// <summary>执行一个独立场景，使外层 Job 不影响其他测试。参数：场景名。返回：零为通过。</summary>
    public static int Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "app-server") { Check(args[1] == "--disable" && args[2] == "plugins", "readonly_instance_flags"); return Fake(); }
        if (args.Length == 1 && args[0] == "fixture-child") { Thread.Sleep(60000); return 0; }
        string mode = args.Length == 0 ? "reuse" : args[0];
        try {
            if (mode == "guard") {
                bool invalid = false; try { using (var unused = new ResidentBudget(0)) { } } catch (InvalidOperationException) { invalid = true; }
                Check(invalid, "invalid_budget_rejected");
                invalid = false; try { using (var unused = new ResidentProcess(typeof(ResidentTests).Assembly.Location, null)) { } } catch (InvalidOperationException) { invalid = true; }
                Check(invalid, "unconstrained_start_rejected");
                using (var foreign = Process.Start(new ProcessStartInfo(typeof(ResidentTests).Assembly.Location, "fixture-child") { UseShellExecute = false, CreateNoWindow = true })) {
                    try {
                        using (var budget = new ResidentBudget(5)) {
                            invalid = false; try { budget.RequireMember(foreign.Handle); } catch (InvalidOperationException) { invalid = true; }
                            Check(invalid && !foreign.HasExited, "foreign_process_preserved");
                            using (var bad = new ResidentNative.Handle(IntPtr.Zero)) {
                                invalid = false; try { ResidentNative.Set(bad, 15, new ResidentNative.Cpu { Flags = 5, Rate = 500 }); } catch (InvalidOperationException) { invalid = true; }
                                Check(invalid, "limit_failure_closed");
                            }
                        }
                    } finally { if (!foreign.HasExited) foreign.Kill(); foreign.WaitForExit(5000); }
                }
                Console.WriteLine("PASS guard"); return 0;
            }
            if (mode == "crash-parent") {
                Environment.SetEnvironmentVariable("RESIDENT_FIXTURE_MODE", "tree");
                Environment.SetEnvironmentVariable("RESIDENT_FIXTURE_CHILD", args[1]);
                using (var budget = new ResidentBudget(5))
                using (var session = new ResidentSession(typeof(ResidentTests).Assembly.Location, budget, 15000, 6000, 1000)) {
                    Console.WriteLine(File.ReadAllText(args[1])); Console.Out.Flush(); Thread.Sleep(60000);
                }
                return 0;
            }
            if (mode == "loop" || mode == "backoff" || mode == "locked" || mode == "cleanup" || mode == "early-fault") {
                string root = args[1]; var waits = new List<int>(); int created = 0;
                Environment.SetEnvironmentVariable("RESIDENT_FIXTURE_MODE", "reuse");
                using (var stop = new ManualResetEvent(false)) {
                    Func<ResidentBudget, IResidentSession> factory = delegate(ResidentBudget budget) {
                        created++; if (mode == "backoff") throw new InvalidOperationException("fixture_init_failure");
                        var session = new ResidentSession(typeof(ResidentTests).Assembly.Location, budget, 8000, 3000, 1000);
                        if (mode == "cleanup") return new UncertainCleanup(session);
                        return mode == "early-fault" ? (IResidentSession)new EarlyFault(session) : session;
                    };
                    Func<WaitHandle[], int, int> wait = delegate(WaitHandle[] events, int milliseconds) { waits.Add(milliseconds); return waits.Count > 8 ? 0 : WaitHandle.WaitAny(events, 10); };
                    Dictionary<string, object> outcome;
                    if (mode == "locked") {
                        using (var held = new FileStream(Path.Combine(root, ".collector.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
                            outcome = ResidentCollector.RunCore(root, 5, false, stop, factory, wait, 3);
                    } else outcome = ResidentCollector.RunCore(root, 5, args.Length > 2 && args[2] == "resume", stop, factory, wait, mode == "early-fault" ? 100 : 3);
                    outcome["created"] = created; outcome["waits"] = waits; Console.WriteLine(Json.Serialize(outcome));
                    return 0;
                }
            }
            if (mode == "policy") {
                Check(ResidentRetry.DelayMilliseconds(1) == 300000 && ResidentRetry.DelayMilliseconds(2) == 900000 && ResidentRetry.DelayMilliseconds(3) == 1800000, "backoff");
                var timer = new ResidentTaskStore(20);
                Check(timer.Read("unused", new Dictionary<string, object>()).Minutes == 20, "actual_internal_timer");
                timer.SetMinutes("unused", new Dictionary<string, object>(), 5);
                Check(timer.Read("unused", new Dictionary<string, object>()).Minutes == 5, "timer_readback");
                bool invalid = false; try { timer.SetMinutes("unused", new Dictionary<string, object>(), 0); } catch { invalid = true; }
                Check(invalid, "invalid_timer"); Console.WriteLine("PASS policy"); return 0;
            }
            if (mode == "task") {
                string sid = WindowsIdentity.GetCurrent().User.Value;
                string xml = "<Task xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><TimeTrigger><StartBoundary>2030-01-01T00:00:00</StartBoundary><Repetition><Interval>PT20M</Interval></Repetition></TimeTrigger></Triggers><Principals><Principal id=\"Author\"><UserId>" + sid + "</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><ExecutionTimeLimit>PT2M</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings><Actions Context=\"Author\"><Exec><Command>C:\\fixture\\bin\\CodexQuotaCollector.exe</Command><Arguments>--run</Arguments></Exec></Actions></Task>";
                string current = ResidentTaskDefinition.ConvertToResident(@"C:\fixture", xml);
                ResidentTaskDefinition.Validate(@"C:\fixture", current);
                Check(current.Contains("--resident") && !current.Contains("Repetition") && current.Contains("PT0S"), "resident_task_limits");
                foreach (string bad in new[] { current.Replace("--resident", "--resident --resume"), current.Replace("LogonTrigger", "BootTrigger"), current.Replace("PT0S", "PT2M"), current.Replace(@"C:\fixture\bin", @"C:\other\bin") }) {
                    bool rejected = false; try { ResidentTaskDefinition.Validate(@"C:\fixture", bad); } catch { rejected = true; }
                    Check(rejected, "foreign_task_rejected");
                }
                Console.WriteLine("PASS task"); return 0;
            }
            Environment.SetEnvironmentVariable("RESIDENT_FIXTURE_MODE", mode);
            using (var budget = new ResidentBudget(5))
            using (var probe = new MemoryProbe(budget, mode == "steady-memory" || mode == "startup-memory" || mode == "cannot-settle")) {
                Check(budget.MemoryLimitMiB == 300 && budget.CpuPercent == 5, "startup_limits");
                string exe = typeof(ResidentTests).Assembly.Location;
                if (mode == "limits") {
                    budget.EnterSteady(); Check(budget.MemoryLimitMiB == 200, "steady_limit");
                    Check(budget.Snapshot().PrivateBytes < 200L * 1048576, "parent_included");
                } else {
                    bool failed = false; Process child = null;
                    string childFile = Path.Combine(Path.GetTempPath(), "resident-child-" + Guid.NewGuid().ToString("N"));
                    Environment.SetEnvironmentVariable("RESIDENT_FIXTURE_CHILD", childFile);
                    try {
                        using (var session = new ResidentSession(exe, budget, 15000, mode == "timeout" ? 200 : 6000, 1000)) {
                            if (mode == "tree") { child = Process.GetProcessById(Int32.Parse(File.ReadAllText(childFile))); var handle = child.Handle; }
                            var first = session.Collect();
                            Check((string)first["account_id"] == "11111111-1111-1111-1111-111111111111", "identity");
                            int rounds = mode == "long" ? 300 : 4;
                            for (int i = 0; i < rounds; i++) session.Collect();
                            Check(session.RequestCount == 1 + (rounds + 1) * 3, "one_initialize_unique_requests");
                            Check(budget.MemoryLimitMiB == 200, "steady_after_initialize");
                            if (mode == "cpu") {
                                var before = budget.Snapshot(); var clock = Stopwatch.StartNew(); Thread.Sleep(2500);
                                double percent = (budget.Snapshot().CpuMilliseconds - before.CpuMilliseconds) / clock.ElapsedMilliseconds / Environment.ProcessorCount * 100;
                                Check(percent < 8, "measured_cpu_cap"); Console.WriteLine("cpu_percent=" + percent.ToString("F2"));
                            }
                        }
                    } catch (InvalidOperationException error) { Console.WriteLine("fixture_failure=" + error.Message); failed = true; }
                    if (child != null) { Check(child.WaitForExit(5000), "owned_descendant_survived"); child.Dispose(); }
                    if (File.Exists(childFile)) File.Delete(childFile);
                    Check(failed == (mode == "timeout" || mode == "mismatch" || mode == "oversize" || mode == "closed" || mode == "startup-memory" || mode == "steady-memory" || mode == "cannot-settle"), "failure_boundary_" + mode);
                    if (mode == "steady-memory") { Console.WriteLine("observed_private_bytes=" + probe.Maximum + " job_peak_counter=" + budget.Snapshot().JobPeakBytes); Check(probe.Maximum > 0 && probe.Maximum <= 200L * 1048576, "steady_hard_limit"); }
                }
                if (mode == "startup-memory" || mode == "cannot-settle") Check(probe.Maximum > 0 && probe.Maximum <= 300L * 1048576, "total_startup_peak_limit");
                Console.WriteLine("PASS " + mode + " private_mib=" + budget.Snapshot().PrivateBytes / 1048576);
            }
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
