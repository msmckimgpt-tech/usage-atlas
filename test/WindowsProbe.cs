using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
internal static class WindowsProbe {
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    private static int Main(string[] args) {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        var json = new JavaScriptSerializer();
        if (args.Length > 0 && args[0] == "child") {
            Console.WriteLine(json.Serialize(new {visible = IsWindowVisible(GetConsoleWindow()), console = GetConsoleWindow().ToInt64()})); return 0;
        }
        if (args.Length > 0 && args[0] == "hold") {
            var child = Process.Start(new ProcessStartInfo("cmd.exe", "/d /c ping -n 30 127.0.0.1 >nul") {UseShellExecute = false});
            Console.WriteLine(json.Serialize(new {pid = Process.GetCurrentProcess().Id, child = child.Id})); Console.Out.Flush(); Thread.Sleep(30000); return 0;
        }
        var info = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "child") {UseShellExecute = false, RedirectStandardOutput = true};
        var process = Process.Start(info); var output = process.StandardOutput.ReadToEnd(); process.WaitForExit();
        Console.WriteLine(json.Serialize(new {visible = IsWindowVisible(GetConsoleWindow()), console = GetConsoleWindow().ToInt64(), child = json.DeserializeObject(output), args = args})); return process.ExitCode;
    }
}
