using System;
using System.Text;

namespace TreeExtractor
{
    // 会话和标准输入/输出的生命周期在此管理；协议编解码由 DesktopProtocol 负责。
    internal static class DesktopBridgeProgram
    {
        [STAThread]
        static void Main()
        {
            DualFrameExperimentOptions.CaptureAtStartup();
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            using (var session = new BackendSession())
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    Console.WriteLine(DesktopProtocol.ProcessLine(line, session.DesktopDispatch));
                    Console.Out.Flush();
                }
            }
        }
    }
}
