using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>常驻采集整树资源读数。参数：由作业对象读取器填充。返回：私有提交、工作集及累计 CPU。</summary>
public sealed class ResidentUsage
{
    public long PrivateBytes, WorkingSetBytes, JobPeakBytes;
    public double CpuMilliseconds;
}

/// <summary>常驻模式的 Windows 互操作边界。参数：仅自有进程和匿名作业句柄。返回：受控内核调用结果。</summary>
internal static class ResidentNative
{
    /// <summary>安全关闭内核句柄。参数：已有句柄。返回：释放成功标记。</summary>
    internal sealed class Handle : SafeHandleZeroOrMinusOneIsInvalid
    {
        /// <summary>包装自有句柄。参数：内核句柄。返回：安全句柄。</summary>
        internal Handle(IntPtr value) : base(true) { SetHandle(value); }
        /// <summary>释放自有句柄。参数：无。返回：系统关闭结果。</summary>
        protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }
    /// <summary>作业基本限制布局。参数：由资源策略填充。返回：原生布局。</summary>
    [StructLayout(LayoutKind.Sequential)] internal struct BasicLimits {
        internal long ProcessTime, JobTime; internal uint Flags;
        internal UIntPtr MinWorking, MaxWorking; internal uint ActiveLimit; internal UIntPtr Affinity; internal uint Priority, Scheduling;
    }
    /// <summary>作业提交量限制布局。参数：基本限制与总提交上限。返回：原生布局。</summary>
    [StructLayout(LayoutKind.Sequential)] internal struct Limits {
        internal BasicLimits Basic; internal ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    /// <summary>CPU 硬限额布局。参数：启用标记与百分比乘一百。返回：原生布局。</summary>
    [StructLayout(LayoutKind.Sequential)] internal struct Cpu { internal uint Flags, Rate; }
    /// <summary>作业 CPU 统计布局。参数：无。返回：累计百纳秒读数及进程数。</summary>
    [StructLayout(LayoutKind.Sequential)] internal struct Accounting {
        internal long User, Kernel, PeriodUser, PeriodKernel; internal uint Faults, Processes, Active, Terminated;
    }
    /// <summary>管道安全属性布局。参数：继承标记。返回：原生布局。</summary>
    [StructLayout(LayoutKind.Sequential)] internal struct Security { internal int Size; internal IntPtr Descriptor; internal int Inherit; }
    /// <summary>进程启动标准流布局。参数：三个白名单句柄。返回：原生布局。</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct Startup {
        internal int Size; internal string Reserved, Desktop, Title; internal uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        internal short Show, ReservedSize; internal IntPtr ReservedPtr, Input, Output, Error;
    }
    /// <summary>扩展启动布局。参数：标准流和属性列表。返回：原生布局。</summary>
    [StructLayout(LayoutKind.Sequential)] internal struct StartupEx { internal Startup Info; internal IntPtr Attributes; }
    /// <summary>挂起进程信息布局。参数：无。返回：新进程与线程句柄。</summary>
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { internal IntPtr Process, Thread; internal uint Pid, Tid; }
    /// <summary>创建匿名作业。参数：空安全属性及空名称。返回：自有句柄。</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObject(IntPtr security, string name);
    /// <summary>设置作业限制。参数：作业、类型、布局及长度。返回：成功标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(Handle job, int kind, IntPtr data, uint size);
    /// <summary>查询作业状态。参数：作业、类型、缓冲及长度。返回：成功标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool QueryInformationJobObject(Handle job, int kind, IntPtr data, uint size, IntPtr returned);
    /// <summary>将自有进程绑定作业。参数：作业和进程句柄。返回：成功标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(Handle job, IntPtr process);
    /// <summary>核验自有作业成员。参数：进程与作业句柄。返回：查询成功与成员标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool IsProcessInJob(IntPtr process, Handle job, out bool included);
    /// <summary>终止自有会话树。参数：会话作业与退出码。返回：成功标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateJobObject(Handle job, uint code);
    /// <summary>关闭自有句柄。参数：句柄。返回：成功标记。</summary>
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr value);
    /// <summary>创建继承管道。参数：两端句柄、安全属性及缓冲大小。返回：成功标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref Security security, uint size);
    /// <summary>限制管道继承。参数：句柄、掩码和标志。返回：成功标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetHandleInformation(SafeFileHandle value, uint mask, uint flags);
    /// <summary>初始化句柄属性列表。参数：列表指针、数量、标志及长度。返回：成功标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
    /// <summary>设置继承白名单。参数：列表、属性及句柄数组。返回：成功标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    /// <summary>释放属性列表。参数：已初始化列表。返回：无。</summary>
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
    /// <summary>挂起创建唯一官方进程。参数：应用、固定参数和白名单启动布局。返回：成功标记及进程信息。</summary>
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcess(string app, StringBuilder args, IntPtr ps, IntPtr ts, bool inherit, uint flags, IntPtr env, string directory, ref StartupEx start, out ProcessInfo info);
    /// <summary>绑定完成后恢复线程。参数：自有主线程。返回：原挂起计数或失败值。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(Handle thread);
    /// <summary>清理未绑定的挂起进程。参数：自有进程与退出码。返回：成功标记。</summary>
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateProcess(Handle process, uint code);
    /// <summary>有限等待自有进程。参数：句柄与毫秒。返回：系统等待状态。</summary>
    [DllImport("kernel32.dll")] internal static extern uint WaitForSingleObject(Handle process, uint milliseconds);
    /// <summary>写入原生布局。参数：句柄、信息类型及结构体。返回：无，失败关闭。</summary>
    internal static void Set<T>(Handle job, int kind, T value) where T : struct {
        int size = Marshal.SizeOf(typeof(T)); IntPtr memory = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(value, memory, false); if (!SetInformationJobObject(job, kind, memory, (uint)size)) throw new InvalidOperationException("resource_limit_failed"); }
        finally { Marshal.FreeHGlobal(memory); }
    }
    /// <summary>读取原生布局。参数：句柄与信息类型。返回：结构体，无法核实时抛异常。</summary>
    internal static T Get<T>(Handle job, int kind) where T : struct {
        int size = Marshal.SizeOf(typeof(T)); IntPtr memory = Marshal.AllocHGlobal(size);
        try { if (!QueryInformationJobObject(job, kind, memory, (uint)size, IntPtr.Zero)) throw new InvalidOperationException("resource_state_unknown"); return (T)Marshal.PtrToStructure(memory, typeof(T)); }
        finally { Marshal.FreeHGlobal(memory); }
    }
}

/// <summary>包含控制进程及后代的硬资源边界。参数：本机 CPU 百分比。返回：启动三百、稳定二百 MiB 总提交预算。</summary>
public sealed class ResidentBudget : IDisposable
{
    private readonly ResidentNative.Handle job;
    public int CpuPercent { get; private set; }
    /// <summary>读取内核实际内存限额。参数：无。返回：MiB。</summary>
    public int MemoryLimitMiB { get { return (int)(ResidentNative.Get<ResidentNative.Limits>(job, 9).JobMemory.ToUInt64() / 1048576); } }
    /// <summary>先设置硬限额，再约束控制进程及其未来后代。参数：一至十的整机 CPU 百分比。返回：预算实例。</summary>
    public ResidentBudget(int cpuPercent) {
        if (cpuPercent < 1 || cpuPercent > 10) throw new InvalidOperationException("invalid_cpu_percent");
        job = new ResidentNative.Handle(ResidentNative.CreateJobObject(IntPtr.Zero, null));
        try {
            if (job.IsInvalid) throw new InvalidOperationException("resource_limit_failed");
            ResidentNative.Set(job, 15, new ResidentNative.Cpu { Flags = 5, Rate = (uint)cpuPercent * 100 });
            SetMemory(300);
            using (var self = Process.GetCurrentProcess()) if (!ResidentNative.AssignProcessToJobObject(job, self.Handle)) throw new InvalidOperationException("resource_bind_failed");
            CpuPercent = (int)ResidentNative.Get<ResidentNative.Cpu>(job, 15).Rate / 100;
            if (CpuPercent != cpuPercent || MemoryLimitMiB != 300) throw new InvalidOperationException("resource_readback_failed");
            if (Snapshot().PrivateBytes >= 300L * 1048576) throw new InvalidOperationException("startup_memory_exceeded");
        } catch { job.Dispose(); throw; }
    }
    /// <summary>设置整树提交预算及低优先级，不允许脱离作业。参数：MiB。返回：无。</summary>
    private void SetMemory(int mib) {
        ResidentNative.Set(job, 9, new ResidentNative.Limits { Basic = new ResidentNative.BasicLimits { Flags = 0x200 | 0x20 | 0x8, Priority = 0x4000, ActiveLimit = 32 }, JobMemory = (UIntPtr)((ulong)mib * 1048576) });
    }
    /// <summary>为显式重建会话恢复启动预算。参数：无。返回：无。</summary>
    public void EnterStartup() { SetMemory(300); }
    /// <summary>核验句柄确属包含控制进程的预算作业。参数：进程句柄。返回：无，非成员则停止。</summary>
    internal void RequireMember(IntPtr process) {
        bool included;
        if (!ResidentNative.IsProcessInJob(process, job, out included) || !included) throw new InvalidOperationException("resource_bind_failed");
    }
    /// <summary>私有提交已经收敛后降低整树硬限额。参数：无。返回：无，不能收敛则失败。</summary>
    public void EnterSteady() {
        if (Snapshot().PrivateBytes >= 200L * 1048576) throw new InvalidOperationException("steady_memory_exceeded");
        SetMemory(200);
        if (MemoryLimitMiB != 200) throw new InvalidOperationException("resource_readback_failed");
        // 下调限额不会追回已经提交的页，必须重检切换瞬间的并发分配后才进入稳定期。
        if (Snapshot().PrivateBytes > 200L * 1048576) throw new InvalidOperationException("steady_memory_exceeded");
    }
    /// <summary>有界枚举作业内的实际进程，记录总提交和工作集。参数：无。返回：读数，信息未知则失败。</summary>
    public ResidentUsage Snapshot() {
        IntPtr data = Marshal.AllocHGlobal(8 + 64 * IntPtr.Size);
        try {
            if (!ResidentNative.QueryInformationJobObject(job, 3, data, (uint)(8 + 64 * IntPtr.Size), IntPtr.Zero)) throw new InvalidOperationException("resource_state_unknown");
            int count = Marshal.ReadInt32(data, 4); if (count < 1 || count > 32) throw new InvalidOperationException("resource_state_unknown");
            var result = new ResidentUsage();
            // 只枚举自有作业成员，不按名称扫描或操作其他桌面进程。
            for (int i = 0; i < count; i++) {
                int pid = checked((int)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64());
                try { using (var p = Process.GetProcessById(pid)) { RequireMember(p.Handle); result.PrivateBytes += p.PrivateMemorySize64; result.WorkingSetBytes += p.WorkingSet64; } }
                catch { throw new InvalidOperationException("resource_state_unknown"); }
            }
            // 内核历史计数单独保留；实际私有提交以进程样本统计，避免混淆失败分配压力下的计数差异。
            result.JobPeakBytes = (long)ResidentNative.Get<ResidentNative.Limits>(job, 9).PeakJobMemory.ToUInt64();
            var cpu = ResidentNative.Get<ResidentNative.Accounting>(job, 1); result.CpuMilliseconds = (cpu.User + cpu.Kernel) / 10000.0;
            return result;
        } finally { Marshal.FreeHGlobal(data); }
    }
    /// <summary>释放预算句柄；控制进程所属限制持续到本进程退出。参数：无。返回：无。</summary>
    public void Dispose() { job.Dispose(); }
}

/// <summary>挂起创建并持有单个官方会话及其后代。参数：官方可执行文件。返回：独占 stdio 流与生命周期句柄。</summary>
public sealed class ResidentProcess : IDisposable
{
    private ResidentNative.Handle job, process;
    public StreamReader Output { get; private set; }
    public StreamWriter Input { get; private set; }
    public Stream Error { get; private set; }
    /// <summary>创建管道并限制继承范围，绑定成功后才恢复。参数：绝对可执行路径及已约束预算。返回：会话实例。</summary>
    public ResidentProcess(string executable, ResidentBudget budget) {
        if (budget == null) throw new InvalidOperationException("resource_bind_failed");
        executable = Path.GetFullPath(executable);
        if (!File.Exists(executable) || executable.Contains("\"")) throw new InvalidOperationException("codex_not_found");
        SafeFileHandle childIn = null, parentIn = null, parentOut = null, childOut = null, parentError = null, childError = null;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero; bool initialized = false;
        ResidentNative.Handle thread = null;
        try {
            job = new ResidentNative.Handle(ResidentNative.CreateJobObject(IntPtr.Zero, null));
            if (job.IsInvalid) throw new InvalidOperationException("resource_limit_failed");
            ResidentNative.Set(job, 9, new ResidentNative.Limits { Basic = new ResidentNative.BasicLimits { Flags = 0x2000 } });
            var security = new ResidentNative.Security { Size = Marshal.SizeOf(typeof(ResidentNative.Security)), Inherit = 1 };
            if (!ResidentNative.CreatePipe(out childIn, out parentIn, ref security, 4096) || !ResidentNative.CreatePipe(out parentOut, out childOut, ref security, 4096) || !ResidentNative.CreatePipe(out parentError, out childError, ref security, 4096)) throw new InvalidOperationException("pipe_failed");
            if (!ResidentNative.SetHandleInformation(parentIn, 1, 0) || !ResidentNative.SetHandleInformation(parentOut, 1, 0) || !ResidentNative.SetHandleInformation(parentError, 1, 0)) throw new InvalidOperationException("pipe_failed");
            IntPtr bytes = IntPtr.Zero; ResidentNative.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            if (bytes == IntPtr.Zero) throw new InvalidOperationException("pipe_failed");
            attributes = Marshal.AllocHGlobal(bytes);
            if (!ResidentNative.InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes)) throw new InvalidOperationException("pipe_failed");
            initialized = true; handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, childIn.DangerousGetHandle()); Marshal.WriteIntPtr(handles, IntPtr.Size, childOut.DangerousGetHandle()); Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, childError.DangerousGetHandle());
            if (!ResidentNative.UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handles, (IntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("pipe_failed");
            var start = new ResidentNative.StartupEx { Attributes = attributes, Info = new ResidentNative.Startup { Size = Marshal.SizeOf(typeof(ResidentNative.StartupEx)), Flags = 0x100, Input = childIn.DangerousGetHandle(), Output = childOut.DangerousGetHandle(), Error = childError.DangerousGetHandle() } };
            ResidentNative.ProcessInfo info;
            if (!ResidentNative.CreateProcess(executable, new StringBuilder("\"" + executable + "\" app-server --disable plugins"), IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, Path.GetDirectoryName(executable), ref start, out info)) throw new InvalidOperationException("appserver_start_failed");
            process = new ResidentNative.Handle(info.Process); thread = new ResidentNative.Handle(info.Thread);
            // 子进程尚未执行用户代码；绑定失败只终止手中这个挂起进程。
            budget.RequireMember(process.DangerousGetHandle());
            if (!ResidentNative.AssignProcessToJobObject(job, process.DangerousGetHandle())) throw new InvalidOperationException("resource_bind_failed");
            Input = new StreamWriter(new FileStream(parentIn, FileAccess.Write, 4096, false), new UTF8Encoding(false), 4096); parentIn = null; Input.AutoFlush = true;
            Output = new StreamReader(new FileStream(parentOut, FileAccess.Read, 4096, false), new UTF8Encoding(false, true), false, 4096); parentOut = null;
            Error = new FileStream(parentError, FileAccess.Read, 4096, false); parentError = null;
            if (ResidentNative.ResumeThread(thread) == UInt32.MaxValue) throw new InvalidOperationException("appserver_start_failed");
        } catch { Dispose(); throw; }
        finally {
            if (thread != null) thread.Dispose();
            if (initialized) ResidentNative.DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            foreach (var handle in new[] { childIn, parentIn, parentOut, childOut, parentError, childError }) if (handle != null) handle.Dispose();
        }
    }
    /// <summary>终止自身会话树，有限等待并释放管道。参数：无。返回：无。</summary>
    public void Dispose() {
        bool confirmed = true;
        try {
            if (job != null) {
                if (!ResidentNative.TerminateJobObject(job, 1)) confirmed = false;
                // 挂起创建后尚未绑定的失败路径也必须回收持有句柄的根进程。
                if (process != null) { ResidentNative.TerminateProcess(process, 1); if (ResidentNative.WaitForSingleObject(process, 5000) != 0) confirmed = false; }
                var clock = Stopwatch.StartNew();
                while (ResidentNative.Get<ResidentNative.Accounting>(job, 1).Active != 0) {
                    if (clock.ElapsedMilliseconds >= 5000) { confirmed = false; break; }
                    Thread.Sleep(50);
                }
            }
        } catch { confirmed = false; }
        finally {
            // 回收后管道可能断开；释放不能因刷新错误跳过作业句柄关闭。
            foreach (var stream in new IDisposable[] { Input, Output, Error }) { try { if (stream != null) stream.Dispose(); } catch { } }
            if (process != null) { process.Dispose(); process = null; } if (job != null) { job.Dispose(); job = null; }
        }
        if (!confirmed) throw new InvalidOperationException("process_tree_cleanup_failed");
    }
}
