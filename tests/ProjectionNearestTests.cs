using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace TreeExtractor
{
    internal static class ProjectionNearestTests
    {
        static int _checks;

        static void Check(bool condition, string message)
        {
            _checks++;
            if (!condition) throw new Exception(message);
        }

        static void Close(double actual, double expected, double tol, string message)
        {
            Check(!double.IsNaN(actual) && Math.Abs(actual - expected) <= tol,
                  message + ": " + actual.ToString("R", CultureInfo.InvariantCulture)
                  + " vs " + expected.ToString("R", CultureInfo.InvariantCulture));
        }

        static void ProjectionTests()
        {
            double[] modes = { Proj.LegacyD, Proj.LowDistortionD };
            double[] points = { -1.0, -0.75, -0.25, 0.0, 0.25, 0.75, 1.0 };
            double[] shifts = { 0.0, 0.4 };
            foreach (double d in modes)
            {
                Proj.NaturalD = d;
                foreach (double vf in new double[] { 40.0, 80.0, 120.0 })
                {
                    double hf = Proj.Hfov(vf, 4.0 / 3.0);
                    double th = Proj.HalfScale(hf / 2.0);
                    double tv = Proj.HalfScale(vf / 2.0);
                    Close(th / tv, 4.0 / 3.0, 1e-11, "4:3 projection ratio");
                    foreach (double shift in shifts)
                        foreach (double tilt in new double[] { -25.0, 0.0, 25.0 })
                            foreach (double u in points)
                                foreach (double v in points)
                                {
                                    double az, el, fx, fy;
                                    Proj.WorldFromPixelNatural(u, v, 359.5, tilt, hf, vf, shift, out az, out el);
                                    // WorldFromPixelNatural deliberately clamps the pole to +/-89 degrees.
                                    if (Math.Abs(el) >= 88.999) continue;
                                    Proj.PixelFromWorld(az, el, 359.5, tilt, th, tv, shift, out fx, out fy);
                                    Close(fx, (u + 1.0) / 2.0, 1e-9, "projection x roundtrip");
                                    Close(fy, (1.0 - v) / 2.0, 1e-9, "projection y roundtrip");
                                }
                }
            }
            double c = Math.Cos(Math.PI / 3.0);
            double legacyRatio = (1.0 + Proj.LegacyD * c) / (Proj.LegacyD + c);
            double lowRatio = (1.0 + Proj.LowDistortionD * c) / (Proj.LowDistortionD + c);
            Close(legacyRatio, 1.25, 1e-12, "legacy local anisotropy at 60 degrees");
            Close(lowRatio, 1.0, 1e-12, "new local anisotropy at 60 degrees");
        }

        static void NearestUnitTests()
        {
            var trees = new List<UtmTree> {
                new UtmTree { Id = 10, X = 1, Y = 0, Z = 0, Height = 2 },
                new UtmTree { Id = 42, X = 5, Y = 0, Z = 0, Height = 3 },
                new UtmTree { Id = 99, X = 0, Y = 0, Z = 0, Height = 0 },
                new UtmTree { Id = 77, X = double.NaN, Y = 0, Z = 0, Height = 3 }
            };
            var axes = new Dictionary<int, double[]> {
                { 10, new double[] { 8, 0 } },
                { 42, new double[] { 0.25, 0 } }
            };
            NearestTree.Result r;
            Check(NearestTree.TryFind(trees, axes, 0, 0, out r), "nearest result exists");
            Check(r.Index == 1 && r.TreeId == 42 && r.UsedTrunkAxis, "tree IDs need not equal indices");
            Close(r.DistanceM, 0.25, 1e-12, "uses measured trunk axis");
            axes[42] = new double[] { double.NaN, 0 };
            Check(NearestTree.TryFind(trees, axes, 0, 0, out r), "invalid trunk falls back");
            Check(r.TreeId == 42 && !r.UsedTrunkAxis, "invalid trunk uses tree center");
            Check(!NearestTree.TryFind(trees, axes, double.NaN, 0, out r), "invalid camera is rejected");
            Check(!NearestTree.TryFind(new List<UtmTree>(), axes, 0, 0, out r), "empty tree list rejected");
            var tie = new List<UtmTree> {
                new UtmTree { Id = 8, X = 1, Y = 0, Height = 2 },
                new UtmTree { Id = 2, X = -1, Y = 0, Height = 2 }
            };
            Check(NearestTree.TryFind(tie, null, 0, 0, out r) && r.Index == 0,
                  "equal distance uses stable input order");
        }

        static void FrameSeparationTests()
        {
            var reservations = new FrameReservations();
            Check(reservations.IsAvailable(0, 106), "unreserved frame available");
            reservations.Reserve(0, 106);
            Check(reservations.IsAvailable(0, 106) && !reservations.IsAvailable(0, 107),
                  "a frame is reserved for its first tree only");
            Check(reservations.OtherOwner(0, 107) == 106 && reservations.OtherOwner(0, 106) == null,
                  "other tree sees the owner, current tree does not");
            bool rejected = false;
            try { reservations.Reserve(0, 107); }
            catch (InvalidOperationException) { rejected = true; }
            Check(rejected && reservations.OtherOwner(0, 107) == 106,
                  "conflicting reservation never displaces the first tree");
            reservations.Reserve(1, 106);
            Check(reservations.IsAvailable(0, 107) && !reservations.IsAvailable(1, 107),
                  "a new frame for the same tree releases its previous reservation");
            reservations.Release(106);
            Check(reservations.IsAvailable(1, 107), "releasing a tree frees its old reservation");
            reservations.Reserve(1, 106);
            reservations.ReserveShared(1, 107);
            Check(!reservations.IsAvailable(1, 106) && !reservations.IsAvailable(1, 107),
                  "explicit shared frames must be unavailable to both automatic choices");
            Check(reservations.OtherOwner(1, 106) == 107 && reservations.OtherOwner(1, 107) == 106,
                  "both users of a shared frame see the other tree");
            reservations.Release(107);
            Check(reservations.IsAvailable(1, 106) && !reservations.IsAvailable(1, 107),
                  "releasing one shared user preserves the other user's reservation");
            reservations.Clear();
            Check(reservations.IsAvailable(1, 107), "new dataset clears frame reservations");

            var target = new FrameSeparation.Axis { Id = 106, X = 0, Y = 10 };
            var front = new FrameSeparation.Axis { Id = 107, X = 0.1, Y = 6.8 };
            var farTree = new FrameSeparation.Axis { Id = 108, X = 0, Y = 100 };
            var invalid = new FrameSeparation.Axis { Id = 109, X = double.NaN, Y = 10 };
            var neighbors = FrameSeparation.Nearby(target, new[] { target, front, farTree, invalid });
            Check(neighbors.Count == 1 && neighbors[0].Id == 107, "only finite nearby axes are assessed");
            var conflict = FrameSeparation.Find(target, neighbors, 0, 0);
            Check(conflict != null && conflict.TreeId == 107 && conflict.AngleDeg < 1,
                  "nearly collinear front and back trunks are ambiguous");
            Check(FrameSeparation.Find(target, neighbors, 10, 5) == null,
                  "a lateral camera can separate the same two trunk axes");
            var wrapTarget = new FrameSeparation.Axis { Id = 4, X = -0.1, Y = 10 };
            var wrapConflict = FrameSeparation.Find(wrapTarget, new[] { front }, 0, 0);
            Check(wrapConflict != null && wrapConflict.AngleDeg < 2,
                  "bearing separation crosses 0 degrees by the shortest arc");
            Check(FrameSeparation.Find(target, neighbors, double.NaN, 0) == null,
                  "invalid camera must not invent a conflict");
            var beyond = new FrameSeparation.Axis { Id = 7, X = 0, Y = 18.001 };
            Check(FrameSeparation.Nearby(target, new[] { beyond }).Count == 0,
                  "distant trees do not become nearby merely through angle");
            var back = new FrameSeparation.Axis { Id = 8, X = 0, Y = -5 };
            Check(FrameSeparation.Find(target, new[] { back }, 0, 0) == null,
                  "opposite directions cannot be treated as the same visual target");
        }

        static void DatasetTest(string dataDir, string expectedPath)
        {
            var forest = new UtmForest();
            Check(forest.Load(Path.Combine(dataDir, "tree_centers2.txt")), "load tree file");
            var axes = new Dictionary<int, double[]>();
            foreach (string line in File.ReadAllLines(Path.Combine(dataDir, "trunk.csv")))
            {
                string[] p = line.Split(',');
                int id; double x, y;
                if (p.Length < 6 || !int.TryParse(p[0], out id) ||
                    !double.TryParse(p[4], NumberStyles.Float, CultureInfo.InvariantCulture, out x) ||
                    !double.TryParse(p[5], NumberStyles.Float, CultureInfo.InvariantCulture, out y)) continue;
                axes[id] = new double[] { x, y };
            }
            var poses = new Dictionary<string, double[]>();
            foreach (string line in File.ReadAllLines(Path.Combine(dataDir, "Metashape.txt")))
            {
                string[] p = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                double x, y;
                if (p.Length < 3 || !p[0].EndsWith(".jpg", StringComparison.OrdinalIgnoreCase) ||
                    !double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out x) ||
                    !double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out y)) continue;
                poses[p[0]] = new double[] { x, y };
            }
            int n = 0;
            foreach (string line in File.ReadAllLines(expectedPath))
            {
                string[] p = line.Split(',');
                if (p.Length < 4 || p[0] == "frame") continue;
                double[] camera; NearestTree.Result r;
                Check(poses.TryGetValue(p[0], out camera), "reference frame exists");
                Check(NearestTree.TryFind(forest.Trees, axes, camera[0], camera[1], out r), "dataset nearest exists");
                Check(r.Index + 1 == int.Parse(p[1], CultureInfo.InvariantCulture), "dataset row index");
                Check(r.TreeId == int.Parse(p[2], CultureInfo.InvariantCulture), "dataset tree ID");
                Close(r.DistanceM, double.Parse(p[3], CultureInfo.InvariantCulture), 1e-6, "dataset distance");
                n++;
            }
            Check(n == poses.Count && n > 0, "all pose rows independently compared");
            Console.WriteLine("DATASET " + Path.GetFileName(dataDir) + " " + n + " frames OK");
        }

        internal static int Run(string[] args)
        {
            try
            {
                ProjectionTests();
                NearestUnitTests();
                FrameSeparationTests();
                Check(args.Length % 2 == 0, "dataset arguments must be in pairs");
                for (int i = 0; i < args.Length; i += 2) DatasetTest(args[i], args[i + 1]);
                Console.WriteLine("PASS " + _checks + " checks");
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine("FAIL " + ex); return 1; }
        }
    }
}
