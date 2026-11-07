using System;
using System.Diagnostics;
using System.Threading;

/// <summary>使用合成进程验证临时进程树，不读取账号、配置或凭据。参数：子进程模式。返回：测试退出码。</summary>
public static class TemporaryTreeTests
{
    /// <summary>启动本测试程序的合成模式。</summary><param name="mode">模式名。</param><returns>已启动的合成进程。</returns>
    private static Process Start(string mode)
    {
        return Process.Start(new ProcessStartInfo(typeof(TemporaryTreeTests).Assembly.Location, mode) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true
        });
    }
    /// <summary>读取合成父进程创建的子进程句柄，读取有超时防止测试悬挂。</summary><param name="parent">合成父进程。</param><returns>合成子进程。</returns>
    private static Process Child(Process parent)
    {
        parent.StandardInput.WriteLine("spawn"); parent.StandardInput.Flush();
        var line = parent.StandardOutput.ReadLineAsync();
        if (!line.Wait(3000)) throw new Exception("fixture_read_timeout");
        return Process.GetProcessById(Int32.Parse(line.Result));
    }
    /// <summary>断言合成进程已退出。</summary><param name="process">本测试进程。</param><returns>无，失败抛异常。</returns>
    private static void Exited(Process process)
    {
        if (!process.WaitForExit(5000)) throw new Exception("fixture_process_survived");
    }
    /// <summary>执行三个生命周期场景及采集超时场景。</summary><param name="args">仅供合成进程切换模式。</param><returns>零为通过。</returns>
    public static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            if (args[0] == "parent" || args[0] == "parent-exit")
            {
                if (Console.ReadLine() != "spawn") return 2;
                using (var child = Start("sleep")) { Console.WriteLine(child.Id); Console.Out.Flush(); }
                if (args[0] == "parent-exit") return 0;
            }
            Thread.Sleep(60000); return 0;
        }
        using (var unrelated = Start("sleep"))
        {
            try
            {
                // 保留独立进程作对照，防止进程树清理误杀其他桌面进程。
                foreach (string mode in new[] { "stop", "dispose", "parent-exit" })
                {
                    using (var parent = Start(mode == "parent-exit" ? mode : "parent"))
                    using (var tree = new TemporaryProcessTree())
                    {
                        try
                        {
                            tree.Attach(parent);
                            using (var child = Child(parent))
                            {
                                parent.Refresh(); child.Refresh();
                                if (child.PriorityClass != ProcessPriorityClass.BelowNormal) throw new Exception("child_priority_mismatch");
                                if (mode != "parent-exit" && parent.PriorityClass != ProcessPriorityClass.BelowNormal) throw new Exception("parent_priority_mismatch");
                                if (mode == "dispose") tree.Dispose();
                                else { if (mode == "parent-exit") Exited(parent); tree.Stop(5000); }
                                Exited(parent); Exited(child);
                            }
                        }
                        finally { if (!parent.HasExited) parent.Kill(); }
                    }
                    if (unrelated.HasExited) throw new Exception("unrelated_process_killed");
                    Console.WriteLine("PASS " + mode);
                }
                // 合成程序忽略 RPC，用短超时验证 Collect 的异常回收路径，不调用真实 CLI。
                bool timedOut = false;
                try { QuotaPrototype.Collect(typeof(TemporaryTreeTests).Assembly.Location, 100); }
                catch (InvalidOperationException e) { timedOut = e.Message == "rpc_timeout"; }
                if (!timedOut) throw new Exception("expected_rpc_timeout");
                Console.WriteLine("PASS collect-timeout");
                return 0;
            }
            finally { if (!unrelated.HasExited) { unrelated.Kill(); unrelated.WaitForExit(5000); } }
        }
    }
}
