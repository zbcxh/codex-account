using System;
using System.IO;
using System.Security.Principal;
using System.Xml;

/// <summary>常驻任务的纯 XML 转换与归属校验，不连接调度服务。参数：设备根及任务定义。返回：受限定义或异常。</summary>
public static class ResidentTaskDefinition
{
    /// <summary>将已核验常驻或周期任务转为实际周期的编译单轮任务，保留身份及启用状态。参数：设备根、原XML与实际分钟。返回：新XML，不注册或启动。</summary>
    public static string ConvertToSingle(string root, string text, int minutes) {
        if (minutes < 1 || minutes > 1440) throw new InvalidOperationException("invalid_task_interval");
        var doc = WindowsQuotaTaskStore.Parse(text); User(doc);
        var actions = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Actions']/*[local-name()='Exec']");
        bool resident = actions != null && Text(actions, "*[local-name()='Arguments']") == "--resident";
        if (resident) Validate(root, text); else WindowsQuotaTaskStore.Validate(root, text);
        Set(actions, "Command", Path.Combine(root, "bin", "CodexQuotaCollector.exe")); Set(actions, "Arguments", "--run");
        if (!resident) { WindowsQuotaTaskStore.Validate(root, doc.OuterXml); return doc.OuterXml; }
        var triggers = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Triggers']"); triggers.RemoveAll();
        var trigger = doc.CreateElement("TimeTrigger", doc.DocumentElement.NamespaceURI); triggers.AppendChild(trigger);
        // 不以修改模式作为立即上报触发，第一次周期从转换后起算。
        var repetition = doc.CreateElement("Repetition", doc.DocumentElement.NamespaceURI); trigger.AppendChild(repetition);
        Set(repetition, "Interval", XmlConvert.ToString(TimeSpan.FromMinutes(minutes))); Set(repetition, "Duration", "P3650D");
        Set(trigger, "StartBoundary", DateTime.Now.AddMinutes(minutes).ToString("yyyy-MM-ddTHH:mm:ss", System.Globalization.CultureInfo.InvariantCulture)); Set(trigger, "Enabled", "true");
        var settings = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']"); Set(settings, "ExecutionTimeLimit", "PT2M");
        string output = doc.OuterXml; WindowsQuotaTaskStore.Validate(root, output); return output;
    }
    /// <summary>取得必须存在的单个节点文本。参数：起点与 XPath。返回：文本，缺失则拒绝。</summary>
    private static string Text(XmlNode node, string xpath) {
        var found = node.SelectSingleNode(xpath); if (found == null) throw new InvalidOperationException("task_not_owned"); return found.InnerText;
    }
    /// <summary>检查任务用户与当前安装用户一致。参数：文档。返回：用户 SID。</summary>
    private static string User(XmlDocument doc) {
        var principals = doc.SelectNodes("/*[local-name()='Task']/*[local-name()='Principals']/*");
        if (principals.Count != 1) throw new InvalidOperationException("task_not_owned");
        string user = Text(principals[0], "*[local-name()='UserId']");
        string logon = Text(principals[0], "*[local-name()='LogonType']");
        if (user != WindowsIdentity.GetCurrent().User.Value || (logon != "S4U" && logon != "InteractiveToken")) throw new InvalidOperationException("unsupported_task_identity");
        return user;
    }
    /// <summary>在原命名空间中写入设置。参数：父节点、名称、值。返回：无。</summary>
    private static void Set(XmlNode parent, string name, string value) {
        var node = parent.SelectSingleNode("*[local-name()='" + name + "']");
        if (node == null) { node = parent.OwnerDocument.CreateElement(name, parent.NamespaceURI); parent.AppendChild(node); }
        node.InnerText = value;
    }
    /// <summary>核对登录触发器用户是否为已验证主体。参数：用户名或SID、当前主体SID。返回：同一身份为真，无法解析为假。</summary>
    private static bool SameTriggerUser(string identity, string sid) {
        if (String.Equals(identity, sid, StringComparison.Ordinal)) return true;
        // Task Scheduler可能将触发器SID导出为本机限定用户名；必须按系统解析后的SID比较，不能按名称猜测归属。
        try { return String.Equals(((SecurityIdentifier)new NTAccount(identity).Translate(typeof(SecurityIdentifier))).Value, sid, StringComparison.Ordinal); }
        catch (IdentityNotMappedException) { return false; }
        catch (ArgumentException) { return false; }
    }
    /// <summary>校验唯一常驻动作、解析后同用户登录触发与无限执行期。参数：设备根与 XML。返回：无，其他或未知归属仍拒绝。</summary>
    public static void Validate(string root, string text) {
        var doc = WindowsQuotaTaskStore.Parse(text); string user = User(doc);
        var actions = doc.SelectNodes("/*[local-name()='Task']/*[local-name()='Actions']/*");
        var triggers = doc.SelectNodes("/*[local-name()='Task']/*[local-name()='Triggers']/*");
        if (actions.Count != 1 || actions[0].LocalName != "Exec" || triggers.Count != 1 || triggers[0].LocalName != "LogonTrigger") throw new InvalidOperationException("task_not_owned");
        string executable = Text(actions[0], "*[local-name()='Command']");
        if (!Path.IsPathRooted(executable) || !String.Equals(Path.GetFullPath(executable), Path.Combine(root, "bin", "CodexQuotaCollector.exe"), StringComparison.OrdinalIgnoreCase) || Text(actions[0], "*[local-name()='Arguments']") != "--resident") throw new InvalidOperationException("task_not_owned");
        if (triggers[0].SelectSingleNode("*[local-name()='Repetition']") != null || !SameTriggerUser(Text(triggers[0], "*[local-name()='UserId']"), user)) throw new InvalidOperationException("task_not_owned");
        var settings = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']");
        if (settings == null || XmlConvert.ToTimeSpan(Text(settings, "*[local-name()='ExecutionTimeLimit']")) != TimeSpan.Zero || Text(settings, "*[local-name()='MultipleInstancesPolicy']") != "IgnoreNew" || settings.SelectSingleNode("*[local-name()='RestartOnFailure']") != null) throw new InvalidOperationException("invalid_resident_task_settings");
    }
    /// <summary>将已核验旧任务转换为同用户常驻任务，保留其他身份和设置。参数：设备根及原 XML。返回：新 XML，不执行注册。</summary>
    public static string ConvertToResident(string root, string text) {
        var doc = WindowsQuotaTaskStore.Parse(text); string user = User(doc);
        var argument = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Actions']/*[local-name()='Exec']/*[local-name()='Arguments']");
        if (argument != null && argument.InnerText == "--resident") { Validate(root, text); return text; }
        WindowsQuotaTaskStore.Validate(root, text);
        var actions = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Actions']/*[local-name()='Exec']");
        Set(actions, "Command", Path.Combine(root, "bin", "CodexQuotaCollector.exe")); Set(actions, "Arguments", "--resident");
        var triggers = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Triggers']"); triggers.RemoveAll();
        var trigger = doc.CreateElement("LogonTrigger", doc.DocumentElement.NamespaceURI); triggers.AppendChild(trigger);
        Set(trigger, "Enabled", "true"); Set(trigger, "UserId", user);
        var settings = doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']");
        if (settings == null) { settings = doc.CreateElement("Settings", doc.DocumentElement.NamespaceURI); doc.DocumentElement.AppendChild(settings); }
        Set(settings, "ExecutionTimeLimit", "PT0S"); Set(settings, "MultipleInstancesPolicy", "IgnoreNew"); Set(settings, "Priority", "9");
        var restart = settings.SelectSingleNode("*[local-name()='RestartOnFailure']"); if (restart != null) settings.RemoveChild(restart);
        string output = doc.OuterXml; Validate(root, output); return output;
    }
}
