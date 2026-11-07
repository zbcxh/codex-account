using System;
using System.Collections.Generic;
using System.IO;

/// <summary>不连接任务服务和网络的原子程序事务。参数：私有根、绑定日志及注入边界。返回：最终阶段或保留恢复证据的异常。</summary>
public static class OtaTransaction
{
    /// <summary>执行或恢复唯一程序替换。参数：根、日志、新摘要、只读健康替身、持久阶段回调、故障注入回调及任务重检。返回：无。</summary>
    public static void Run(string root, Dictionary<string, object> state, string nextHash, Func<bool> health, Action<string> persist, Action<string> checkpoint, Action guard = null)
    {
        string current = OtaCore.PathIn(root, "bin/CodexQuotaCollector.exe"), candidate = OtaCore.PathIn(root, "ota/candidate.exe"), previous = OtaCore.PathIn(root, "ota/previous.exe");
        string phase = QuotaClient.String(state, "phase"), oldHash = QuotaClient.String(state, "previous_hash");
        if (OtaClient.Terminal(phase)) return;
        if (guard != null) guard();
        if (phase != "verified" && phase != "replacing" && phase != "replaced" && phase != "rolling_back") throw new InvalidOperationException("ota_transaction_stage");
        if (phase == "verified" || phase == "replacing") {
            // 原子替换前后摘要形成两种合法恢复证据，任何第三方字节都必须停止。
            if (OtaCore.Hash(current) == oldHash) {
                if (!File.Exists(candidate) || OtaCore.Hash(candidate) != nextHash || File.Exists(previous)) throw new InvalidOperationException("ota_artifact_conflict");
                persist("replacing"); checkpoint("before_replace"); if (guard != null) guard(); File.Replace(candidate, current, previous); checkpoint("after_replace");
            } else if (OtaCore.Hash(current) != nextHash || !File.Exists(previous) || OtaCore.Hash(previous) != oldHash) throw new InvalidOperationException("ota_current_conflict");
            persist("replaced"); checkpoint("after_replaced_log");
        }
        if (phase == "rolling_back") {
            if (OtaCore.Hash(current) == oldHash && !File.Exists(previous)) { persist("rolled_back"); return; }
            if (guard != null) guard(); Restore(root, nextHash, oldHash); persist("rolled_back"); return;
        }
        if (OtaCore.Hash(current) != nextHash) throw new InvalidOperationException("ota_current_conflict");
        checkpoint("before_health"); bool healthy = health(); checkpoint("after_health");
        if (healthy) { persist("installed"); checkpoint("after_installed_log"); }
        else {
            // 回滚也先记录意图，断电不能把已恢复的旧摘要当作第三方冲突。
            state["error"] = "local_health_failed"; persist("rolling_back"); checkpoint("before_rollback"); if (guard != null) guard(); Restore(root, nextHash, oldHash); checkpoint("after_rollback"); persist("rolled_back");
        }
    }
    /// <summary>仅恢复摘要绑定的上一版本。参数：根、新摘要及旧摘要。返回：无。</summary>
    private static void Restore(string root, string nextHash, string oldHash)
    {
        string current = OtaCore.PathIn(root, "bin/CodexQuotaCollector.exe"), previous = OtaCore.PathIn(root, "ota/previous.exe");
        if (OtaCore.Hash(current) != nextHash || !File.Exists(previous) || OtaCore.Hash(previous) != oldHash) throw new InvalidOperationException("ota_rollback_conflict");
        File.Replace(previous, current, null);
    }
}
