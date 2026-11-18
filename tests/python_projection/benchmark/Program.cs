using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;

namespace TreeExtractor
{
    // Test-only timing loop around the actual C# methods. Parsing is outside the timer.
    internal static class ProjectionBenchmark
    {
        private static double[][] ReadCases(JsonElement root, string property)
        {
            var cases = new List<double[]>();
            foreach (JsonElement item in root.GetProperty(property).EnumerateArray())
            {
                var values = new List<double>();
                foreach (JsonElement value in item.EnumerateArray()) values.Add(value.GetDouble());
                if (values.Count != 8 || values[7] != 1.0)
                    throw new ArgumentException("Each case must have seven arguments and d=1.");
                cases.Add(values.ToArray());
            }
            if (cases.Count == 0) throw new ArgumentException("Cases must not be empty.");
            return cases.ToArray();
        }

        private static int Main()
        {
            try
            {
                using (JsonDocument input = JsonDocument.Parse(Console.ReadLine()))
                {
                    double[][] pixel = ReadCases(input.RootElement, "pixel");
                    double[][] natural = ReadCases(input.RootElement, "natural");
                    Proj.NaturalD = 1.0;
                    Console.WriteLine(JsonSerializer.Serialize(new
                    {
                        ready = true,
                        runtime = Environment.Version.ToString()
                    }));
                    string line;
                    while ((line = Console.ReadLine()) != null)
                    {
                        using (JsonDocument command = JsonDocument.Parse(line))
                        {
                            string operation = command.RootElement.GetProperty("operation").GetString();
                            if (operation == "stop") return 0;
                            int repetitions = command.RootElement.GetProperty("repetitions").GetInt32();
                            if (repetitions <= 0)
                                throw new ArgumentException("Repetitions must be positive.");
                            double[][] cases;
                            if (operation == "pixel") cases = pixel;
                            else if (operation == "natural") cases = natural;
                            else throw new ArgumentException("Unknown operation.");

                            double checksum = 0.0;
                            var watch = Stopwatch.StartNew();
                            if (operation == "pixel")
                            {
                                for (int repeat = 0; repeat < repetitions; repeat++)
                                    foreach (double[] a in cases)
                                    {
                                        double first, second;
                                        Proj.PixelFromWorld(a[0], a[1], a[2], a[3], a[4], a[5], a[6],
                                                            out first, out second);
                                        checksum += first + second;
                                    }
                            }
                            else
                            {
                                for (int repeat = 0; repeat < repetitions; repeat++)
                                    foreach (double[] a in cases)
                                    {
                                        double first, second;
                                        Proj.WorldFromPixelNatural(a[0], a[1], a[2], a[3], a[4], a[5], a[6],
                                                                   out first, out second);
                                        checksum += first + second;
                                    }
                            }
                            watch.Stop();
                            Console.WriteLine(JsonSerializer.Serialize(new
                            {
                                seconds = watch.Elapsed.TotalSeconds,
                                calls = (long)repetitions * cases.Length,
                                checksum
                            }));
                        }
                    }
                }
                return 0;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(exception);
                return 1;
            }
        }
    }
}
