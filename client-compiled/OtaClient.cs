using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

/// <summary>当前上报之后的可选 OTA 通道，不处理历史队列响应。参数：私有设备根。返回：能力或任务结果。</summary>
public static class OtaClient
{
    /// <summary>加载手工固定信任根。参数：根。返回：公钥或空。</summary>
    public static Dictionary<string, object> Trust(string root) { string p = OtaCore.PathIn(root, "ota.trust.json"); if (!File.Exists(p)) return null; QuotaClient.CheckPrivate(root); return QuotaClient.Read(p, false); }
    /// <summary>加载持久阶段。参数：根。返回：记录。</summary>
    public static Dictionary<string, object> State(string root) { return QuotaClient.Read(OtaCore.PathIn(root, "ota/state.json"), true); }
    /// <summary>读取最高接受序号；无根时不宣称支持。参数：根。返回：能力或空。</summary>
    public static Dictionary<string, object> Capability(string root) { var t = Trust(root); if (t == null) return null; var s = State(root); return QuotaPrototype.Obj("protocol", 1, "release_seq", s.ContainsKey("highest_seq") ? s["highest_seq"] : 0, "key_id", QuotaClient.String(t, "key_id")); }
    /// <summary>识别最终阶段。参数：阶段名称。返回：是否最终。</summary>
    public static bool Terminal(string phase) { return phase == "installed" || phase == "rolled_back" || phase == "failed"; }
    /// <summary>尽力确认当前本地阶段，不重试不确定写入。参数：根及日志。返回：无，网络失败留待正常联系。</summary>
    public static void Ack(string root, Dictionary<string, object> state)
    {
        try { var config = QuotaClient.Read(OtaCore.PathIn(root, "config.json"), false); string phase = QuotaClient.String(state, "phase"); if (phase == "downloading") phase = "pending"; if (phase == "replacing") phase = "waiting_exit"; if (phase == "replaced" || phase == "rolling_back") phase = "checking"; var body = QuotaPrototype.Obj("job_id", state["job_id"], "state", phase); if (state.ContainsKey("error")) body["error"] = state["error"]; QuotaClient.Post(Endpoint(config, "ack"), QuotaClient.Token(root), OtaCore.Json.Serialize(body)); } catch { QuotaClient.Log(root, "ota_ack_pending"); }
    }
    /// <summary>构建同源固定 API。参数：配置及 API 后缀。返回：URI。</summary>
    private static Uri Endpoint(Dictionary<string, object> config, string suffix) { return new Uri(QuotaPrototype.Endpoint(QuotaClient.String(config, "server_url")), "client/ota/" + suffix); }
    /// <summary>从当前成功上报后查询并暂存唯一任务。参数：根及配置。返回：无；故障仅写脱敏日志。</summary>
    public static void PollAfterCurrentReport(string root, Dictionary<string, object> config)
    { Poll(root, config, new WindowsOtaEnvironment()); }
    /// <summary>执行当前联系的 OTA 流程，外部边界可供隔离测试替换，CLI 不提供替换入口。参数：根、配置与环境。返回：无。</summary>
    public static void Poll(string root, Dictionary<string, object> config, IOtaEnvironment environment)
    {
        if (Trust(root) == null) return;
        string taskToStart = null;
        try {
            QuotaClient.PrivateDirectory(root, OtaCore.PathIn(root, "ota"));
            using (var held = new FileStream(OtaCore.PathIn(root, "ota/poll.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
                var state = State(root); string phase = QuotaClient.String(state, "phase"), token = environment.Token(root);
                if (Terminal(phase)) { var ack = QuotaPrototype.Obj("job_id", state["job_id"], "state", phase); if (state.ContainsKey("error")) ack["error"] = state["error"]; environment.Post(Endpoint(config, "ack"), token, OtaCore.Json.Serialize(ack)); }
                // 未决任务只恢复同一固定升级器，不能用新任务覆盖断电证据。
                if (phase != null && !Terminal(phase)) { taskToStart = QuotaClient.String(state, "updater_task"); return; }
                var response = environment.Post(Endpoint(config, "poll"), token, OtaCore.Json.Serialize(QuotaPrototype.Obj("capability", Capability(root))));
                if (!Object.Equals(QuotaClient.Get(response, "ok"), true)) return;
                var data = QuotaClient.Get(response, "data") as Dictionary<string, object>; if (Object.Equals(QuotaClient.Get(data, "replay"), true)) return; var job = QuotaClient.Get(data, "job") as Dictionary<string, object>; if (job == null) return;
                string id = QuotaClient.String(job, "job_id"); Guid parsed;
                if (!Guid.TryParseExact(id, "D", out parsed) || QuotaClient.String(job, "client_id") != QuotaClient.String(config, "client_id") || id == QuotaClient.String(state, "job_id")) return;
                long floor = state.ContainsKey("highest_seq") ? QuotaClient.Integer(state["highest_seq"], 0, 9007199254740991) : 0;
                string manifest = QuotaClient.String(job, "manifest"), signature = QuotaClient.String(job, "signature");
                var m = OtaCore.Verify(manifest, signature, Trust(root), floor, OtaCore.Now());
                if (Convert.ToInt64(job["seq"]) != Convert.ToInt64(m["release_seq"]) || QuotaClient.String(job, "download_path") != "/api/client/ota/download/" + id) throw new InvalidOperationException("ota_job_mismatch");
                string taskName = (QuotaClient.String(config, "task_name") ?? "CodexQuotaMonitor") + "-OTA";
                string taskXml = environment.Task(QuotaClient.String(config, "task_name") ?? "CodexQuotaMonitor", root, false, false);
                string updaterXml = environment.Task(taskName, root, true, false);
                string staged = OtaCore.PathIn(root, "ota/candidate.exe"); if (File.Exists(staged)) throw new InvalidOperationException("ota_orphan_candidate");
                state = QuotaPrototype.Obj("job_id", id, "phase", "downloading", "manifest", manifest, "signature", signature, "highest_seq", floor, "previous_hash", OtaCore.Hash(OtaCore.PathIn(root, "bin/CodexQuotaCollector.exe")), "task_xml", taskXml, "task_name", QuotaClient.String(config, "task_name") ?? "CodexQuotaMonitor", "updater_task", taskName, "updater_xml", updaterXml, "was_paused", File.Exists(OtaCore.PathIn(root, "resident.paused.json")), "was_running", environment.IsRunning(QuotaClient.String(config, "task_name") ?? "CodexQuotaMonitor", root));
                OtaCore.Save(root, state); environment.Post(Endpoint(config, "ack"), token, OtaCore.Json.Serialize(QuotaPrototype.Obj("job_id", id, "state", "pending")));
                environment.Download(Endpoint(config, "download/" + id), token, staged, m);
                state["phase"] = "verified"; state["highest_seq"] = m["release_seq"];
                OtaCore.Save(root, state); environment.Post(Endpoint(config, "ack"), token, OtaCore.Json.Serialize(QuotaPrototype.Obj("job_id", id, "state", "verified"))); taskToStart = taskName;
            }
        } catch { QuotaClient.Log(root, "ota_poll_deferred"); }
        finally {
            // 启动请求必须晚于 poll.lock 释放，否则快速启动的升级器会把本次正常领取误判为并发下载。
            if (taskToStart != null) { try { environment.Task(taskToStart, root, true, true); } catch { QuotaClient.Log(root, "ota_start_deferred"); } }
        }
    }
    /// <summary>检查升级器停止请求，不删除暂停标记。参数：根。返回：是否请求退出。</summary>
    public static bool StopRequested(string root) { return File.Exists(OtaCore.PathIn(root, "ota/stop.request")); }
    /// <summary>等待日志绑定的升级器退出，不按进程名处理其他实例。参数：根。返回：无，身份冲突或超时拒绝启动。</summary>
    public static void WaitForUpdater(string root)
    {
        var s = State(root); if (!s.ContainsKey("updater_pid")) { if (StopRequested(root)) throw new InvalidOperationException("ota_recovery_required"); return; }
        try { using (var process = Process.GetProcessById(Convert.ToInt32(s["updater_pid"]))) {
            // PID 创建时间改变说明原实例已经退出；不能把复用该 PID 的新进程当作升级器。
            if (process.StartTime.ToUniversalTime().Ticks != Convert.ToInt64(s["updater_start_ticks"])) { if (StopRequested(root)) throw new InvalidOperationException("ota_recovery_required"); return; }
            if (!String.Equals(process.MainModule.FileName, OtaCore.PathIn(root, "bin/CodexQuotaUpdater.exe"), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("ota_updater_identity");
            if (!process.WaitForExit(300000)) throw new InvalidOperationException("ota_updater_busy");
        } } catch (ArgumentException) { }
        if (StopRequested(root)) throw new InvalidOperationException("ota_recovery_required");
    }
    /// <summary>只读健康检查，不读取令牌、不创建身份、不启动官方进程。参数：根。返回：脱敏结果。</summary>
    public static Dictionary<string, object> HealthCheck(string root)
    {
        QuotaClient.CheckPrivate(root); QuotaClient.CheckPrivate(OtaCore.PathIn(root, "bin")); var config = QuotaClient.Read(OtaCore.PathIn(root, "config.json"), false);
        if (String.IsNullOrEmpty(QuotaClient.String(config, "client_id"))) throw new InvalidOperationException("ota_config_identity"); QuotaPrototype.Endpoint(QuotaClient.String(config, "server_url"));
        var s = State(root); if (QuotaClient.String(s, "phase") != "replaced") throw new InvalidOperationException("ota_health_stage");
        var m = OtaCore.Verify(QuotaClient.String(s, "manifest"), QuotaClient.String(s, "signature"), Trust(root), Convert.ToInt64(s["highest_seq"]) - 1, Math.Min(OtaCore.Now(), Convert.ToInt64(OtaCore.Json.Deserialize<Dictionary<string, object>>(QuotaClient.String(s, "manifest"))["expires_at"]) - 1));
        if (OtaCore.Hash(OtaCore.PathIn(root, "bin/CodexQuotaCollector.exe")) != QuotaClient.String(m, "sha256")) throw new InvalidOperationException("ota_health_version");
        // 健康子进程只初始化自有空资源边界，不采集、不配对、不读取令牌。
        using (var budget = new ResidentBudget(5)) { if (budget.CpuPercent != 5 || budget.MemoryLimitMiB != 300 || budget.Snapshot().PrivateBytes >= 300L * 1048576) throw new InvalidOperationException("ota_health_resource"); }
        OtaCore.RequireHeldLock(OtaCore.PathIn(root, "ota/upgrade.lock")); OtaCore.RequireHeldLock(OtaCore.PathIn(root, ".collector.lock"));
        if (!StopRequested(root)) throw new InvalidOperationException("ota_health_lock");
        using (var updater = Process.GetProcessById(Convert.ToInt32(s["updater_pid"]))) { if (updater.StartTime.ToUniversalTime().Ticks != Convert.ToInt64(s["updater_start_ticks"]) || !String.Equals(updater.MainModule.FileName, OtaCore.PathIn(root, "bin/CodexQuotaUpdater.exe"), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("ota_updater_identity"); }
        return QuotaPrototype.Obj("ok", true, "protocol", 1, "version", m["version"], "release_seq", m["release_seq"], "local_only", true);
    }
}

/// <summary>固定任务启动的独立替换器。参数：仅 --apply。返回：退出码，不采集或重配。</summary>
public static class OtaUpdater
{
    /// <summary>设置阶段并持久化。参数：根、日志和阶段。返回：无。</summary>
    private static void Phase(string root, Dictionary<string, object> state, string phase) { state["phase"] = phase; OtaCore.Save(root, state); OtaClient.Ack(root, state); }
    /// <summary>恢复或执行单次替换，持锁期间禁止另一升级。参数：根。返回：无。</summary>
    public static void Apply(string root)
    {
        QuotaClient.CheckPrivate(root); QuotaClient.CheckPrivate(OtaCore.PathIn(root, "bin")); string area = OtaCore.PathIn(root, "ota"); QuotaClient.CheckPrivate(area);
        // 先与领取者使用同一把锁，登录恢复不得删除仍在下载的候选或覆盖正在提交的阶段。
        using (var polling = OtaCore.TryLock(OtaCore.PathIn(root, "ota/poll.lock"))) {
        if (polling == null) return;
        using (var held = OtaCore.TryLock(OtaCore.PathIn(root, "ota/upgrade.lock"))) {
            if (held == null) return;
            var s = OtaClient.State(root); string phase = QuotaClient.String(s, "phase"); if (phase == null) return;
            var self = Process.GetCurrentProcess(); s["updater_pid"] = self.Id; s["updater_start_ticks"] = self.StartTime.ToUniversalTime().Ticks; OtaCore.Save(root, s);
            if (OtaClient.Terminal(phase)) { Finish(root, s); Resume(root, s); return; }
            if (phase == "downloading") { string partial = OtaCore.PathIn(root, "ota/candidate.exe"); if (File.Exists(partial)) File.Delete(partial); s["error"] = "download_interrupted"; Phase(root, s, "failed"); return; }
            if (OtaTasks.Access(QuotaClient.String(s, "task_name"), root, false, false) != QuotaClient.String(s, "task_xml") || OtaTasks.Access(QuotaClient.String(s, "updater_task"), root, true, false) != QuotaClient.String(s, "updater_xml")) throw new InvalidOperationException("ota_task_changed");
            var rawManifest = OtaCore.Json.Deserialize<Dictionary<string, object>>(QuotaClient.String(s, "manifest"));
            // 已进入原子替换的本地恢复不能因断电后清单过期失去唯一回滚机会；签名和摘要仍必须通过。
            long verificationTime = Math.Min(OtaCore.Now(), Convert.ToInt64(rawManifest["expires_at"]) - 1);
            var m = OtaCore.Verify(QuotaClient.String(s, "manifest"), QuotaClient.String(s, "signature"), OtaClient.Trust(root), Convert.ToInt64(s["highest_seq"]) - 1, verificationTime);
            if (OtaCore.ExpireVerified(root, s, m, OtaCore.Now())) { OtaClient.Ack(root, s); Finish(root, s); return; }
            string current = OtaCore.PathIn(root, "bin/CodexQuotaCollector.exe"), next = OtaCore.PathIn(root, "ota/candidate.exe"), previous = OtaCore.PathIn(root, "ota/previous.exe"), stop = OtaCore.PathIn(root, "ota/stop.request"); string hash = QuotaClient.String(m, "sha256");
            QuotaClient.Atomic(root, stop, QuotaClient.String(s, "job_id"));
            // 只等待已有生命周期锁；不终止任何按名称发现的未知进程。
            FileStream lifecycle = null; DateTime deadline = DateTime.UtcNow.AddMinutes(5);
            while (lifecycle == null) { try { lifecycle = new FileStream(OtaCore.PathIn(root, ".collector.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); } catch (IOException) { if (DateTime.UtcNow >= deadline) { s["error"] = "stop_timeout"; Phase(root, s, "failed"); File.Delete(stop); return; } Thread.Sleep(250); } }
            using (lifecycle) {
                OtaTransaction.Run(root, s, hash,
                    delegate { return OtaCore.RunHealth(current, root); },
                    delegate(string value) { Phase(root, s, value); }, delegate(string point) { },
                    delegate { if (OtaTasks.Access(QuotaClient.String(s, "task_name"), root, false, false) != QuotaClient.String(s, "task_xml") || OtaTasks.Access(QuotaClient.String(s, "updater_task"), root, true, false) != QuotaClient.String(s, "updater_xml")) throw new InvalidOperationException("ota_task_changed"); });
                Finish(root, s);
            }
            Resume(root, s);
        }
        }
    }
    /// <summary>最终阶段至多请求一次原来运行的任务，保持暂停与禁用。参数：根及日志。返回：无。</summary>
    private static void Resume(string root, Dictionary<string, object> state)
    {
        if (!OtaClient.Terminal(QuotaClient.String(state, "phase")) || QuotaClient.String(state, "phase") == "failed" || Object.Equals(QuotaClient.Get(state, "resume_attempted"), true)) return;
        if (Object.Equals(QuotaClient.Get(state, "was_running"), true) && !Object.Equals(QuotaClient.Get(state, "was_paused"), true) && !File.Exists(OtaCore.PathIn(root, "resident.paused.json"))) {
            if (OtaTasks.Access(QuotaClient.String(state, "task_name"), root, false, false) != QuotaClient.String(state, "task_xml")) throw new InvalidOperationException("ota_task_changed");
            state["resume_attempted"] = true; OtaCore.Save(root, state); OtaTasks.Access(QuotaClient.String(state, "task_name"), root, false, true);
        }
    }
    /// <summary>幂等清理最终阶段的自有停止标记与旧包。参数：根及日志。返回：无。</summary>
    private static void Finish(string root, Dictionary<string, object> state)
    {
        string stop = OtaCore.PathIn(root, "ota/stop.request"), previous = OtaCore.PathIn(root, "ota/previous.exe");
        if (File.Exists(stop)) { if (File.ReadAllText(stop) != QuotaClient.String(state, "job_id")) throw new InvalidOperationException("ota_stop_conflict"); File.Delete(stop); }
        if (QuotaClient.String(state, "phase") == "installed" && File.Exists(previous)) { if (OtaCore.Hash(previous) != QuotaClient.String(state, "previous_hash")) throw new InvalidOperationException("ota_previous_conflict"); File.Delete(previous); }
        if (QuotaClient.String(state, "error") == "manifest_expired") { string candidate = OtaCore.PathIn(root, "ota/candidate.exe"); if (File.Exists(candidate)) { var manifest = OtaCore.Json.Deserialize<Dictionary<string, object>>(QuotaClient.String(state, "manifest")); if (OtaCore.Hash(candidate) != QuotaClient.String(manifest, "sha256")) throw new InvalidOperationException("ota_artifact_conflict"); File.Delete(candidate); } }
    }
    /// <summary>独立任务入口。参数：固定 --apply。返回：成功零，拒绝非零。</summary>
    public static int Main(string[] args)
    {
        string root = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\')).FullName;
        try { if (args.Length != 1 || args[0] != "--apply") return 2; Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.Idle; Apply(root); return 0; }
        catch { try { var state = OtaClient.State(root); if (state.ContainsKey("job_id")) { state["error"] = "recovery_required"; OtaCore.Save(root, state); OtaClient.Ack(root, state); } } catch { } return 1; }
    }
}
