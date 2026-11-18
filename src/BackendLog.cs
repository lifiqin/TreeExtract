using System;
using System.IO;

namespace TreeExtractor
{
    internal static class BackendLog
    {
        static readonly object Sync = new object();
        static readonly string PathName = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "error.log");

        internal static void Write(string message)
        {
            try { lock (Sync) File.AppendAllText(PathName, DateTime.Now.ToString("HH:mm:ss.fff ") + message + Environment.NewLine); }
            catch { /* 日志失败不能中断业务处理。 */ }
        }
    }
}
