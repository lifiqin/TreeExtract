using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace TreeExtractor
{
    internal static class QAFullNearest
    {
        static double Number(string value)
        {
            return double.Parse(value, NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        internal static int Run(string[] args)
        {
            var frames = new List<FrameInfo>();
            foreach (string name in File.ReadAllLines(args[0]))
                if (!string.IsNullOrWhiteSpace(name)) frames.Add(new FrameInfo { Name = name.Trim() });
            var poses = new Dictionary<string, double[]>(StringComparer.OrdinalIgnoreCase);
            foreach (string line in File.ReadLines(args[1]))
            {
                string[] fields = line.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                if (fields.Length < 7) continue;
                var p = new double[6];
                bool ok = true;
                for (int j = 0; j < 6; j++)
                    if (!double.TryParse(fields[j + 1], NumberStyles.Float, CultureInfo.InvariantCulture, out p[j])) ok = false;
                if (ok) poses[fields[0]] = p;
            }
            int checkedTrees = 0;
            foreach (string line in File.ReadLines(args[2]))
            {
                string[] p = line.Split(',');
                if (p.Length != 5) continue;
                int index; double distance;
                if (!NearestFrame.TryFind(frames, poses, Number(p[1]), Number(p[2]), out index, out distance))
                    throw new Exception("No frame for tree " + p[0]);
                double expectedDistance = Number(p[4]);
                if (!string.Equals(frames[index].Name, p[3], StringComparison.OrdinalIgnoreCase)
                    || Math.Abs(distance - expectedDistance) > 1e-6)
                    throw new Exception("Nearest mismatch for tree " + p[0] + ": " + frames[index].Name + " vs " + p[3]);
                checkedTrees++;
            }
            Console.WriteLine("Nearest all-tree cross-check: " + checkedTrees + " PASS");
            return 0;
        }
    }
}
