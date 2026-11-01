using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Launcher
{
    private const string Url = "http://127.0.0.1:3000/";
    private static Process server;
    private static IntPtr job;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JobInfo info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInfo
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobInfo
    {
        public BasicLimitInfo BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    private static int Main()
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string node = Path.Combine(root, "node.exe");
            string app = Path.Combine(root, "app");
            if (!File.Exists(node) || !File.Exists(Path.Combine(app, "server.js")))
                throw new Exception("Extract the entire ZIP before running EduFlow.exe.");
            var listener = new TcpListener(IPAddress.Loopback, 3000);
            try { listener.Start(); } catch (SocketException) { throw new Exception("Port 3000 is already in use. Close the other server and try again."); }
            finally { listener.Stop(); }

            job = CreateJobObject(IntPtr.Zero, null);
            var info = new JobInfo();
            info.BasicLimitInformation.LimitFlags = 0x2000; // Kill child processes when this window closes.
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(JobInfo))))
                throw new Exception("Could not create the server process group.");
            var start = new ProcessStartInfo(node, "server.js");
            start.WorkingDirectory = app;
            start.UseShellExecute = false;
            start.EnvironmentVariables["HOSTNAME"] = "127.0.0.1";
            start.EnvironmentVariables["PORT"] = "3000";
            server = Process.Start(start);
            if (server == null || !AssignProcessToJobObject(job, server.Handle))
                throw new Exception("Could not attach the server to the launcher.");
            Console.WriteLine("Starting EduFlow at " + Url);
            bool ready = false;
            for (int i = 0; i < 120 && !server.HasExited; i++)
            {
                try
                {
                    var request = (HttpWebRequest)WebRequest.Create(Url);
                    request.Timeout = 1000;
                    using (var response = (HttpWebResponse)request.GetResponse()) ready = response.StatusCode == HttpStatusCode.OK;
                    if (ready) break;
                }
                catch (WebException) { }
                Thread.Sleep(500);
            }
            if (!ready) throw new Exception("The server did not start. See the output above for details.");
            try { if (Environment.GetEnvironmentVariable("EDUFLOW_NO_BROWSER") != "1") Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true }); }
            catch { Console.WriteLine("Open this address in your browser: " + Url); }
            Console.WriteLine("EduFlow is running. Press Enter or close this window to stop the server.");
            Console.ReadLine();
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("EduFlow: " + error.Message);
            Console.Error.WriteLine("Press Enter to close.");
            Console.ReadLine();
            return 1;
        }
        finally
        {
            if (server != null && !server.HasExited) { try { server.Kill(); } catch { } }
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
