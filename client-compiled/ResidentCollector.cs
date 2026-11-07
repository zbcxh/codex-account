using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;

/// <summary>常驻内部调度器，不将旧任务重复触发器当实际周期。参数：初始实际分钟数。返回：可读回的内存定时状态。</summary>
public sealed class ResidentTaskStore : IQuotaTaskStore
{
    private int minutes;
    private readonly string stateRoot;
    /// <summary>建立内部定时器。参数：一至一千四百四十分钟。返回：调度器。</summary>
    public ResidentTaskStore(int minutes) { SetMinutes(null, null, minutes); }
    /// <summary>恢复可持久读回的内部定时器。参数：实际分钟数与设备根。返回：调度器。</summary>
    public ResidentTaskStore(int minutes, string stateRoot) { this.stateRoot = stateRoot; SetMinutes(null, null, minutes); }
    /// <summary>读取本实例实际采用的等待周期。参数：兼容根目录和配置，均不访问。返回：实际分钟。</summary>
    public QuotaTaskSnapshot Read(string root, Dictionary<string, object> config) { return new QuotaTaskSnapshot { Minutes = minutes }; }
    /// <summary>仅调整内部等待周期，不修改 Windows 任务。参数：兼容根目录、配置及新分钟数。返回：无。</summary>
    public void SetMinutes(string root, Dictionary<string, object> config, int minutes) {
        if (minutes < 1 || minutes > 1440) throw new InvalidOperationException("invalid_task_interval");
        // 只有持久化成功才切换本实例周期，避免重启后使用旧周期却回报新确认。
        if (stateRoot != null) QuotaClient.Atomic(stateRoot, QuotaClient.Fence(stateRoot, Path.Combine(stateRoot, "resident.schedule.json")), new JavaScriptSerializer().Serialize(QuotaPrototype.Obj("interval_minutes", minutes)));
        this.minutes = minutes;
    }
}

/// <summary>限定冷启动重试次数与等待。参数：失败计数。返回：固定退避预算。</summary>
public static class ResidentRetry
{
    /// <summary>取得五、十五、三十分钟退避。参数：一至三次连续失败。返回：毫秒。</summary>
    public static int DelayMilliseconds(int failures) {
        if (failures < 1 || failures > 3) throw new InvalidOperationException("invalid_retry_count");
        return new[] { 300000, 900000, 1800000 }[failures - 1];
    }
}

/// <summary>常驻生命周期与可靠上报编排。参数：已有设备目录、本机程序与资源选择。返回：脱敏退出状态。</summary>
public static class ResidentCollector
{
    /// <summary>运行正式常驻模式，只有显式入口才会创建会话。参数：已有状态、官方路径、CPU百分比、恢复标记与停止事件。返回：退出状态。</summary>
    public static Dictionary<string, object> Run(string root, string codex, int cpuPercent, bool resume, WaitHandle stop) {
        return RunCore(root, cpuPercent, resume, stop,
            delegate(ResidentBudget budget) {
                var config = QuotaClient.Read(QuotaClient.Fence(root, Path.Combine(root, "config.json")), false);
                string exe = QuotaPrototype.ResolveCodex(codex ?? QuotaClient.String(config, "codex_path"));
                return new ResidentSession(exe, budget, 120000, 60000, 30000);
            }, delegate(WaitHandle[] events, int milliseconds) { return WaitWithOta(root, events, milliseconds); }, Int32.MaxValue);
    }
    /// <summary>分片检查本机升级退出请求，不增加网络或RPC频率。参数：私有根、停止及故障事件、总等待毫秒。返回：事件索引或超时；升级请求映射为停止。</summary>
    private static int WaitWithOta(string root, WaitHandle[] events, int milliseconds) {
        int remaining = milliseconds;
        while (remaining > 0) {
            if (OtaClient.StopRequested(root)) return 0;
            int slice = Math.Min(remaining, 1000), next = WaitHandle.WaitAny(events, slice);
            if (next != WaitHandle.WaitTimeout) return next;
            remaining -= slice;
        }
        return WaitHandle.WaitTimeout;
    }
    /// <summary>执行可替换会话与等待边界的状态机；测试不能通过命令行替换正式参数。参数：根、CPU、恢复、停止、会话工厂、等待器与轮数。返回：退出状态。</summary>
    internal static Dictionary<string, object> RunCore(string root, int cpuPercent, bool resume, WaitHandle stop, Func<ResidentBudget, IResidentSession> create, Func<WaitHandle[], int, int> wait, int maxSamples) {
        if (cpuPercent < 1 || cpuPercent > 10) throw new InvalidOperationException("invalid_cpu_percent");
        root = Path.GetFullPath(root).TrimEnd('\\'); QuotaClient.Fence(root, root);
        if (!Directory.Exists(root)) throw new InvalidOperationException("state_directory_missing"); QuotaClient.CheckPrivate(root);
        FileStream held;
        try { held = new FileStream(QuotaClient.Fence(root, Path.Combine(root, ".collector.lock")), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { return QuotaPrototype.Obj("ok", true, "skipped", "collector_busy", "exit_code", 0); }
        using (held) {
            string paused = QuotaClient.Fence(root, Path.Combine(root, "resident.paused.json"));
            if (File.Exists(paused)) { if (!resume) return QuotaPrototype.Obj("ok", false, "error", "resident_paused", "exit_code", 2); File.Delete(paused); }
            var config = QuotaClient.Read(QuotaClient.Fence(root, Path.Combine(root, "config.json")), false);
            // 第一次启动即明确采用内部周期；缺失实际字段时兼容五分钟，不伪称期望值已应用。
            object interval; int minutes = config.TryGetValue("reporting_interval_minutes", out interval) ? (int)QuotaClient.Integer(interval, 1, 1440) : 5;
            string schedule = QuotaClient.Fence(root, Path.Combine(root, "resident.schedule.json"));
            if (File.Exists(schedule)) minutes = (int)QuotaClient.Integer(QuotaClient.Get(QuotaClient.Read(schedule, false), "interval_minutes"), 1, 1440);
            var timer = new ResidentTaskStore(minutes, root); int failures = 0, samples = 0;
            using (var budget = new ResidentBudget(cpuPercent)) {
                while (!stop.WaitOne(0) && !OtaClient.StopRequested(root)) {
                    bool goodSession = false;
                    try {
                        using (var session = create(budget)) {
                            while (!stop.WaitOne(0) && !OtaClient.StopRequested(root)) {
                                var report = session.Collect(); goodSession = true;
                                // 网络及可靠队列失败不销毁健康官方会话；下一次只按正常周期重试，不进行紧循环。
                                try { QuotaClient.RunCollected(root, report, timer); }
                                catch { QuotaClient.Log(root, "resident_report_failed"); }
                                samples++; if (samples >= maxSamples) return QuotaPrototype.Obj("ok", true, "samples", samples, "exit_code", 0);
                                int next = wait(new[] { stop, session.Faulted }, checked(timer.Read(root, config).Minutes * 60000));
                                if (OtaClient.StopRequested(root)) return QuotaPrototype.Obj("ok", true, "stopped", true, "exit_code", 0);
                                if (next == 0) return QuotaPrototype.Obj("ok", true, "stopped", true, "exit_code", 0);
                                if (next == 1) throw new InvalidOperationException("resident_session_faulted");
                                // 必须健康度过完整正常等待周期才清零；一次短暂成功不能掩盖反复冷启动故障。
                                failures = 0;
                            }
                        }
                    } catch (Exception error) {
                        failures++; string code = error is InvalidOperationException ? error.Message : "resident_session_failed";
                        if (code.Length > 64 || !System.Text.RegularExpressions.Regex.IsMatch(code, "^[a-z_]+$")) code = "resident_session_failed";
                        QuotaClient.Log(root, code);
                        if (code == "process_tree_cleanup_failed") {
                            // 清理未知不属于可重试故障，立即暂停以免旧树与新树叠加。
                            QuotaClient.Atomic(root, paused, new JavaScriptSerializer().Serialize(QuotaPrototype.Obj("reason", code, "consecutive_failures", failures)));
                            return QuotaPrototype.Obj("ok", false, "error", "resident_paused", "exit_code", 2);
                        }
                        if (failures >= 3) {
                            // 在最后退避前持久化暂停，进程被关闭或再次触发也不会重启风暴。
                            QuotaClient.Atomic(root, paused, new JavaScriptSerializer().Serialize(QuotaPrototype.Obj("reason", code, "consecutive_failures", failures)));
                        }
                        if (wait(new[] { stop }, ResidentRetry.DelayMilliseconds(Math.Min(3, failures))) == 0) return QuotaPrototype.Obj("ok", true, "stopped", true, "exit_code", 0);
                        if (failures >= 3) return QuotaPrototype.Obj("ok", false, "error", "resident_paused", "exit_code", 2);
                    }
                    // 正常停止不会被当作启动失败；会话已回收后才允许下次冷启动。
                    if (goodSession && stop.WaitOne(0)) break;
                }
            }
            return QuotaPrototype.Obj("ok", true, "stopped", true, "exit_code", 0);
        }
    }
}
