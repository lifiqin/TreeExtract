using System;
using System.Collections.Generic;
using System.Text.Json;

namespace TreeExtractor
{
    // This is a test-only oracle: compile the actual C# sources, not a rewritten formula.
    internal static class ProjectionOracle
    {
        private static int Main()
        {
            try
            {
                using (JsonDocument document = JsonDocument.Parse(Console.In.ReadToEnd()))
                {
                    var results = new List<double[]>();
                    foreach (JsonElement request in document.RootElement.EnumerateArray())
                    {
                        Proj.NaturalD = request.GetProperty("d").GetDouble();
                        var values = new List<double>();
                        foreach (JsonElement value in request.GetProperty("args").EnumerateArray())
                            values.Add(value.GetDouble());
                        double[] a = values.ToArray();
                        double first, second;
                        switch (request.GetProperty("operation").GetString())
                        {
                            case "half_scale":
                                results.Add(new[] { Proj.HalfScale(a[0]) });
                                break;
                            case "horizontal_fov":
                                results.Add(new[] { Proj.Hfov(a[0], a[1]) });
                                break;
                            case "pixel_from_world":
                                Proj.PixelFromWorld(a[0], a[1], a[2], a[3], a[4], a[5], a[6],
                                                    out first, out second);
                                results.Add(new[] { first, second });
                                break;
                            case "world_from_pixel_pinhole":
                                Proj.WorldFromPixel(a[0], a[1], a[2], a[3], a[4], a[5],
                                                    out first, out second);
                                results.Add(new[] { first, second });
                                break;
                            case "world_from_pixel_natural":
                                Proj.WorldFromPixelNatural(a[0], a[1], a[2], a[3], a[4], a[5], a[6],
                                                           out first, out second);
                                results.Add(new[] { first, second });
                                break;
                            default:
                                throw new ArgumentException("Unknown projection operation.");
                        }
                    }
                    Console.Write(JsonSerializer.Serialize(results));
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
