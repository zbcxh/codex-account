using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

/// <summary>隔离任务替身。参数：合成状态目录。返回：只读写合成任务文件的任务实现。</summary>
public sealed class FixtureTasks : IQuotaTaskStore
{
    /// <summary>读取合成任务。</summary><param name="root">测试目录。</param><param name="config">测试配置。</param><returns>合成周期。</returns>
    public QuotaTaskSnapshot Read(string root, Dictionary<string, object> config)
    {
        string path = Path.Combine(root, "fixture-task.txt");
        return new QuotaTaskSnapshot { Minutes = File.Exists(path) ? Int32.Parse(File.ReadAllText(path)) : 5 };
    }
    /// <summary>修改测试文件模拟任务更新。</summary><param name="root">测试目录。</param><param name="config">测试配置。</param><param name="minutes">目标周期。</param><returns>无。</returns>
    public void SetMinutes(string root, Dictionary<string, object> config, int minutes)
    {
        if (File.Exists(Path.Combine(root, "deny-task-update"))) throw new UnauthorizedAccessException();
        File.WriteAllText(Path.Combine(root, "fixture-task.txt"), minutes.ToString());
    }
}

/// <summary>仅测试程序集入口。参数：合成目录与模式。返回：测试结果，不分发到正式客户端。</summary>
public static class QuotaClientTestDriver
{
    /// <summary>生成双份合成 DPAPI 令牌，不读取真实令牌。</summary><param name="root">新测试目录。</param><returns>无。</returns>
    private static void Seed(string root)
    {
        Directory.CreateDirectory(root);
        var acl = new System.Security.AccessControl.DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
        foreach (string sid in new[] { System.Security.Principal.WindowsIdentity.GetCurrent().User.Value, "S-1-5-18", "S-1-5-32-544" })
            acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier(sid), System.Security.AccessControl.FileSystemRights.FullControl, System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit, System.Security.AccessControl.PropagationFlags.None, System.Security.AccessControl.AccessControlType.Allow));
        Directory.SetAccessControl(root, acl);
        byte[] token = Encoding.UTF8.GetBytes("fixture-token");
        File.WriteAllBytes(Path.Combine(root, "token.bin"), ProtectedData.Protect(token, null, DataProtectionScope.CurrentUser));
        File.WriteAllBytes(Path.Combine(root, "token.lm.bin"), ProtectedData.Protect(token, null, DataProtectionScope.LocalMachine));
    }
    /// <summary>校验 XML 安全边界。</summary><returns>通过数量。</returns>
    private static int XmlTests()
    {
        string root = @"C:\fixture";
        string xml = "<Task xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><TimeTrigger><StartBoundary>2030-01-01T00:00:00</StartBoundary><Repetition><Interval>P1D</Interval></Repetition></TimeTrigger></Triggers><Actions><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -File &quot;C:\\fixture\\bin\\Collect-CodexQuota.ps1&quot;</Arguments></Exec></Actions></Task>";
        if (WindowsQuotaTaskStore.Validate(root, xml) != 1440) throw new Exception("xml_interval");
        string native = xml.Replace("powershell.exe", @"C:\fixture\bin\CodexQuotaCollector.exe").Replace("-NoProfile -File &quot;C:\\fixture\\bin\\Collect-CodexQuota.ps1&quot;", "--run");
        if (WindowsQuotaTaskStore.Validate(root, native) != 1440) throw new Exception("xml_compiled_action");
        foreach (string bad in new[] { xml.Replace("</Actions>", "<ComHandler /></Actions>"), xml.Replace("</Triggers>", "<LogonTrigger /></Triggers>"), native.Replace("--run", "--run --state-dir C:\\other"), xml.Replace("P1D", "PT1M1S"), xml.Replace("C:\\fixture\\bin\\Collect-CodexQuota.ps1", "C:\\other.ps1") })
        {
            bool rejected = false; try { WindowsQuotaTaskStore.Validate(root, bad); } catch { rejected = true; }
            if (!rejected) throw new Exception("unsafe_task_accepted");
        }
        return 7;
    }
    /// <summary>执行隔离测试命令。</summary><param name="args">测试模式、目录及合成参数。</param><returns>零为成功。</returns>
    public static int Main(string[] args)
    {
        try
        {
            var json = new JavaScriptSerializer(); string mode = args[0]; string root = args.Length > 1 ? args[1] : null;
            if (mode == "seed") { Seed(root); Console.WriteLine("{\"ok\":true}"); return 0; }
            if (mode == "xml") { Console.WriteLine(json.Serialize(QuotaPrototype.Obj("ok", true, "tests", XmlTests()))); return 0; }
            if (mode == "token") { if (QuotaClient.Token(root) != "fixture-token") throw new Exception("token_mismatch"); Console.WriteLine("{\"ok\":true}"); return 0; }
            if (mode == "inspect-task") { var task = new WindowsQuotaTaskStore().Read(root, QuotaClient.Read(Path.Combine(root, "config.json"), false)); Console.WriteLine(json.Serialize(QuotaPrototype.Obj("ok", true, "minutes", task.Minutes))); return 0; }
            if (mode == "apply") { var cfg = QuotaClient.Read(Path.Combine(root, "config.json"), false); var ack = QuotaClient.Apply(root, cfg, json.Deserialize<Dictionary<string, object>>(args[2]), new FixtureTasks()); Console.WriteLine(json.Serialize(QuotaPrototype.Obj("ok", true, "ack", ack))); return 0; }
            Dictionary<string, object> result;
            if (mode == "busy")
            {
                using (var held = new FileStream(Path.Combine(root, ".collector.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) result = QuotaClient.Run(root, args[2], args[3], false, new FixtureTasks());
            }
            else result = QuotaClient.Run(root, args[2], args[3], mode == "dry", new FixtureTasks());
            Console.WriteLine(json.Serialize(result)); return Convert.ToInt32(result["exit_code"]);
        }
        catch { Console.Error.WriteLine("{\"ok\":false,\"error\":\"fixture_rejected\"}"); return 1; }
    }
}
