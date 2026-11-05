using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class CollectorHost {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public int cb;
        public string reserved, desktop, title;
        public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2;
        public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo {public IntPtr process, thread; public uint id, threadId;}
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minimumWorkingSet, maximumWorkingSet;
        public uint activeProcessLimit;
        public UIntPtr affinity;
        public uint priorityClass, schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;}
    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimit {
        public BasicLimit basic;
        public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint SearchPath(string path, string name, string extension, int length, StringBuilder result, IntPtr filePart);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimit limit, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private static IntPtr Inherit(int kind) {
        IntPtr handle;
        if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out handle, 0, true, 2)) throw new Win32Exception();
        return handle;
    }
    private static string Quote(string value) {
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') {slashes++; continue;}
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); text.Append(c); slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    [STAThread]
    private static int Main(string[] args) {
        if (args.Length < 1) return 64;
        IntPtr job = IntPtr.Zero;
        var info = new ProcessInfo();
        var startup = new StartupInfo();
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            var limit = new JobLimit(); limit.basic.flags = 0x2000;
            if (!SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(JobLimit)))) throw new Win32Exception();
            startup.cb = Marshal.SizeOf(typeof(StartupInfo)); startup.flags = 0x101; startup.showWindow = 0;
            startup.input = Inherit(-10); startup.output = Inherit(-11); startup.error = Inherit(-12);
            var command = new StringBuilder();
            foreach (string arg in args) {if (command.Length > 0) command.Append(' '); command.Append(Quote(arg));}
            string executable = args[0];
            if (!Path.IsPathRooted(executable)) {
                if (executable.IndexOfAny(new[] {'\\', '/'}) >= 0) executable = Path.GetFullPath(executable);
                else {var found = new StringBuilder(32768); uint length = SearchPath(Environment.GetEnvironmentVariable("PATH"), executable, ".exe", found.Capacity, found, IntPtr.Zero); if (length == 0 || length >= found.Capacity) throw new Win32Exception(); executable = found.ToString();}
            }
            // 숨긴 콘솔을 하위 명령에 상속하고, 호스트 종료 시 전체 조회 트리를 정리한다.
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x14, IntPtr.Zero, null, ref startup, out info)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job, info.process)) throw new Win32Exception();
            if (ResumeThread(info.thread) == uint.MaxValue) throw new Win32Exception();
            if (WaitForSingleObject(info.process, uint.MaxValue) != 0) throw new Win32Exception();
            uint code; if (!GetExitCodeProcess(info.process, out code)) throw new Win32Exception();
            return unchecked((int)code);
        } catch {if (info.process != IntPtr.Zero) TerminateProcess(info.process, 70); return 70;}
        finally {
            foreach (IntPtr handle in new[] {info.thread, info.process, startup.input, startup.output, startup.error, job}) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
}
