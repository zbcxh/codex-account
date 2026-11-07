using System;
using System.Text.RegularExpressions;
// 功能：模拟只读额度服务并产生大量无换行错误流。参数：命令行参数。返回：通过标准输出返回固定测试响应。
public class QuotaMemoryFixture {
    // 功能：校验临时实例启动范围并处理合成 RPC 请求。参数：仅禁用 plugins 的 app-server 参数。返回：无。
    public static void Main(string[] args) {
        // 拒绝持久化功能管理命令和额外开关，确保优化只作用于本次只读临时实例。
        if (args.Length != 3 || args[0] != "app-server" || args[1] != "--disable" || args[2] != "plugins") {
            Environment.ExitCode = 2;
            return;
        }
        string line;
        string block = new string('x', 4096);
        while ((line = Console.ReadLine()) != null) {
            var match = Regex.Match(line, "\"id\"\\s*:\\s*(\\d+)");
            if (!match.Success) continue;
            int id = int.Parse(match.Groups[1].Value);
            // 多次填满系统管道，验证排空操作独立于标准输出响应和换行。
            for (int i=0; i<256; i++) Console.Error.Write(block);
            Console.Error.Flush();
            string body;
            if (id == 1) body = "{\"userAgent\":\"memory-fixture\"}";
            else if (id == 3) body = "{\"accountId\":\"11111111-1111-1111-1111-111111111111\",\"rateLimits\":{\"limitId\":\"codex\",\"primary\":{\"usedPercent\":23,\"windowDurationMins\":300,\"resetsAt\":1900000000}}}";
            else body = "{\"account\":{\"type\":\"chatgpt\",\"email\":\"fixture@example.invalid\",\"planType\":\"pro\"},\"workspaceRouting\":{\"chatgptAccountId\":\"11111111-1111-1111-1111-111111111111\"}}";
            Console.WriteLine("{\"id\":" + id + ",\"result\":" + body + "}");
            Console.Out.Flush();
        }
    }
}
