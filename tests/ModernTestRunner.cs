using System;
using System.Linq;

namespace TreeExtractor
{
    // 不依赖测试框架的回归入口，确保测试与产品使用同一 .NET 运行时。
    internal static class ModernTestRunner
    {
        static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine("Specify protocol, projection, dual, physical, geometry, nearest, person-head, or data-integrity.");
                return 2;
            }
            string[] remaining = args.Skip(1).ToArray();
            switch (args[0])
            {
                case "protocol": return DesktopProtocolTests.Run();
                case "projection": return ProjectionNearestTests.Run(remaining);
                case "dual": return DualFrameRegressionTests.Run();
                case "physical": return DualFramePhysicalTests.Run(remaining);
                case "geometry": return QAGeometryTests.Run();
                case "nearest": return QAFullNearest.Run(remaining);
                case "person-head": return PersonHeadTests.Run(remaining);
                case "data-integrity": return DataIntegrityTests.Run();
                default:
                    Console.Error.WriteLine("Unknown test mode: " + args[0]);
                    return 2;
            }
        }
    }
}
