using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;

namespace TreeExtractor
{
    /// <summary>双帧与最近相机的合成几何/图像回归；不写入项目数据。</summary>
    internal static class DualFrameRegressionTests
    {
        static int checks;

        static void Check(bool condition, string message)
        {
            checks++;
            if (!condition) throw new Exception(message);
        }

        static void Close(double actual, double expected, double tolerance, string message)
        {
            Check(!double.IsNaN(actual) && Math.Abs(actual - expected) <= tolerance,
                  message + ": " + actual + " vs " + expected);
        }

        static void TestNearestFrame()
        {
            var frames = new List<FrameInfo> {
                new FrameInfo { Name = "bad.jpg" },
                new FrameInfo { Name = "far.jpg" },
                new FrameInfo { Name = "near.jpg" },
                new FrameInfo { Name = "tie.jpg" },
                new FrameInfo { Name = "missing.jpg" }
            };
            var poses = new Dictionary<string, double[]> {
                { "bad.jpg", new double[] { double.NaN, 0, 0, 0, 0, 0 } },
                { "far.jpg", new double[] { 5, 0, 0, 0, 0, 0 } },
                { "near.jpg", new double[] { 1, 0, 0, 0, 0, 0 } },
                { "tie.jpg", new double[] { -1, 0, 0, 0, 0, 0 } }
            };
            int index; double distance;
            Check(NearestFrame.TryFind(frames, poses, 0, 0, out index, out distance), "nearest exists");
            Check(index == 2, "nearest skips invalid poses and keeps stable tie order");
            Close(distance, 1.0, 1e-9, "nearest distance");
            Check(!NearestFrame.TryFind(frames, poses, double.NaN, 0, out index, out distance), "invalid tree");
        }

        static void TestCameraPoseValidation()
        {
            Check(CameraPose.ComponentCount == 6 && DualFrameConfig.PoseDofCount == 6,
                  "pose layout remains X/Y/Z/Omega/Phi/Kappa");
            Check(!CameraPose.IsValid(null), "null pose rejected");
            for (int length = 0; length < 6; length++)
                Check(!CameraPose.IsValid(new double[length]), "incomplete pose rejected: " + length);
            Check(CameraPose.IsValid(new double[6]), "zero-valued pose remains valid");
            Check(CameraPose.IsValid(new double[] { 0, 0, 0, 0, 0, 0, double.NaN }),
                  "unused trailing fields do not invalidate the existing pose layout");

            var frames = new List<FrameInfo> {
                new FrameInfo { Name = "near.jpg" }, new FrameInfo { Name = "fallback.jpg" }
            };
            var poses = new Dictionary<string, double[]> {
                { "near.jpg", new double[6] },
                { "fallback.jpg", new double[] { 3, 4, 0, 0, 0, 0 } }
            };
            int index; double distance;
            foreach (double invalid in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity })
                for (int component = 0; component < 6; component++)
                {
                    var pose = new double[6];
                    pose[component] = invalid;
                    Check(!CameraPose.IsValid(pose), "each non-finite pose component is rejected");
                    poses["near.jpg"] = pose;
                    Check(NearestFrame.TryFind(frames, poses, 0, 0, out index, out distance) && index == 1,
                          "nearest-frame selection applies the shared pose contract");
                    Close(distance, 5, 1e-12, "invalid near pose falls back to valid camera");
                }
            poses["near.jpg"] = new double[6];
            Check(NearestFrame.TryFind(frames, poses, 0, 0, out index, out distance) && index == 0 && distance == 0,
                  "zero distance is valid, not the missing-camera sentinel");
        }

        static void TestCommonSegment()
        {
            var a = new TrunkMeasure { ZBot = 0.3, ZTop = 5.0 };
            var b = new TrunkMeasure { ZBot = 0.8, ZTop = 3.4 };
            double low, high, middle;
            Check(DualFrameGeometry.TryCommonVisibleHeight(a, b, 8.0, out low, out high, out middle), "overlap exists");
            Close(low, 0.8, 1e-9, "overlap lower bound");
            Close(high, 3.4, 1e-9, "overlap upper bound");
            Close(middle, 2.1, 1e-9, "middle is not capped at 2m");
            b.ZBot = 5.1;
            b.ZTop = 7.0;
            Check(!DualFrameGeometry.TryCommonVisibleHeight(a, b, 8.0, out low, out high, out middle), "disjoint segments rejected");
            b.ZBot = -2;
            b.ZTop = 9;
            Check(DualFrameGeometry.TryCommonVisibleHeight(a, b, 2.0, out low, out high, out middle), "tree bounds clipped");
            Close(high, 2.0, 1e-9, "upper bound at tree top");
            a.ZTop = double.NaN;
            Check(!DualFrameGeometry.TryCommonVisibleHeight(a, b, 8, out low, out high, out middle), "invalid height rejected");

            a.ZBot = 0.2; a.ZTop = 2.0;
            b.ZBot = 0.2; b.ZTop = 0.7;
            Check(!DualFrameGeometry.TryPrimaryVisibleMidpoint(a, b, 5, out low, out high, out middle),
                  "secondary frame must cover primary midpoint");
            b.ZBot = 0.5; b.ZTop = 1.5;
            Check(DualFrameGeometry.TryPrimaryVisibleMidpoint(a, b, 5, out low, out high, out middle),
                  "primary midpoint supported by secondary");
            Close(middle, 1.1, 1e-9, "use primary visible midpoint rather than common midpoint");
            Check(DualFrameGeometry.GeometricAgreement(a, b, low, high, 0.424, 0.75) > 0.15,
                  "opposite angular deviations do not invalidate a good physical intersection");
        }

        static void TestHorizontalIntersection()
        {
            double[] a = { 0, 0 }, b = { 10, 0 };
            double x, y;
            double azB = Geo.Deg(Math.Atan2(-10, 10));
            Check(DualFrameGeometry.TryIntersectHorizontal(a, 0, b, azB, out x, out y), "forward rays intersect");
            Close(x, 0, 1e-9, "intersection x");
            Close(y, 10, 1e-9, "intersection y");
            Check(!DualFrameGeometry.TryIntersectHorizontal(a, 0, b, 179, out x, out y), "opposite near-parallel rays rejected");
            Check(!DualFrameGeometry.TryIntersectHorizontal(a, 0, b, 5, out x, out y), "near-parallel rays rejected");
            Check(!DualFrameGeometry.TryIntersectHorizontal(a, 0, b, 45, out x, out y), "backward intersection rejected");
        }

        static void TestCandidateBaseline()
        {
            var frames = new List<FrameInfo> {
                new FrameInfo { Name = "a" }, new FrameInfo { Name = "opposite" }, new FrameInfo { Name = "side" }
            };
            var poses = new Dictionary<string, double[]> {
                { "a", new double[] { 0, 0, 1, 0, 0, 0 } },
                { "opposite", new double[] { 0, 20, 1, 0, 0, 0 } },
                { "side", new double[] { 10, 10, 1, 0, 0, 0 } }
            };
            var tree = new UtmTree { Id = 1, X = 0, Y = 10, Z = 0, Height = 5 };
            var candA = new FrameCandidate { Index = 0, Dh = 10, AzT = 0 };
            var opposite = new FrameCandidate { Index = 1, Dh = 10, AzT = 180 };
            var side = new FrameCandidate { Index = 2, Dh = 10, AzT = 270 };
            var ctx = new DualFrameContext { Frames = frames, MetaPose = poses, SegmentOf = delegate { return 1; } };
            var input = new DualFrameInput { Tree = tree, FrameA = frames[0], CandA = candA, Candidates = new List<FrameCandidate> { candA, opposite } };
            FallbackReason reason; double angle;
            Check(DualFrameEngine.SelectB(ctx, input, out reason, out angle) == null, "180 degree baseline rejected");
            input.Candidates.Add(side);
            Check(DualFrameEngine.SelectB(ctx, input, out reason, out angle) == side, "non-degenerate frame selected");
            Close(angle, 90, 1e-9, "effective baseline angle");
        }

        static void TestFlightSegments()
        {
            var frames = new List<FrameInfo> { new FrameInfo { Name = "a" }, new FrameInfo { Name = "b" } };
            var poses = new Dictionary<string, double[]> {
                { "a", new double[] { 0, 0, 1, 0, 0, 0 } },
                { "b", new double[] { 10, 10, 1, 0, 0, 0 } }
            };
            var tree = new UtmTree { Id = 1, X = 0, Y = 10, Z = 0, Height = 5 };
            var a = new FrameCandidate { Index = 0, Dh = 10, AzT = 0 };
            var b = new FrameCandidate { Index = 1, Dh = 10, AzT = 270 };
            var ctx = new DualFrameContext { Frames = frames, MetaPose = poses };
            var input = new DualFrameInput { Tree = tree, FrameA = frames[0], CandA = a,
                                             Candidates = new List<FrameCandidate> { a, b } };
            FallbackReason reason; double angle;
            ctx.SegmentOf = delegate(string name) { return name == "a" ? -1 : 1; };
            Check(DualFrameEngine.SelectB(ctx, input, out reason, out angle) == null &&
                  reason == FallbackReason.MissingFlightSegment, "missing primary flight segment must reject");
            ctx.SegmentOf = delegate(string name) { return name == "a" ? 1 : -1; };
            Check(DualFrameEngine.SelectB(ctx, input, out reason, out angle) == null &&
                  reason == FallbackReason.MissingFlightSegment, "missing secondary flight segment must reject");
            ctx.SegmentOf = delegate(string name) { return name == "a" ? 1 : 2; };
            Check(DualFrameEngine.SelectB(ctx, input, out reason, out angle) == null &&
                  reason == FallbackReason.CrossFlight, "known different flight segments must reject");
            ctx.SegmentOf = null;
            Check(DualFrameEngine.SelectB(ctx, input, out reason, out angle) == b,
                  "synthetic caller without segment provider retains explicit legacy behavior");
            poses["b"][3] = double.NaN;
            Check(DualFrameEngine.SelectB(ctx, input, out reason, out angle) == null &&
                  reason == FallbackReason.MissingPose, "secondary non-finite pose must reject");
        }

        static void TestObservationAndCalibration()
        {
            const int width = 800, height = 400;
            var tree = new UtmTree { Id = 1, X = 0, Y = 0, Z = 0, Height = 5 };
            var candidate = new FrameCandidate { Dh = 5, AzT = 180, A0 = 0, ElB = -40, ElT = 40 };
            double[] pose = { 0, 0, 1.5, 0, 0, 0 };
            using (var horizontalBands = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            using (Graphics g = Graphics.FromImage(horizontalBands))
            {
                g.Clear(Color.FromArgb(130, 170, 130));
                using (var brush = new SolidBrush(Color.FromArgb(70, 70, 70)))
                    g.FillRectangle(brush, 0, 195, width, 35);
                TrunkMeasure falseMeasure;
                Check(!TrunkObservation.MeasureEx(horizontalBands, tree, candidate, pose, 0, 0, out falseMeasure),
                      "horizontal bands cannot become a trunk solely due to center prior");
            }
            using (var image = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            using (Graphics g = Graphics.FromImage(image))
            {
                g.Clear(Color.FromArgb(140, 180, 140));
                using (var brush = new SolidBrush(Color.FromArgb(60, 40, 30)))
                    g.FillRectangle(brush, 394, 170, 12, 75);
                TrunkMeasure normal, shifted;
                Check(TrunkObservation.MeasureEx(image, tree, candidate, pose, 0, 0, out normal), "synthetic trunk observed");
                Check(TrunkObservation.MeasureEx(image, tree, candidate, pose, 0, 5, out shifted), "synthetic trunk observed with CalV");
                Close(shifted.ElPix, normal.ElPix - 5, 1e-9, "CalV midpoint world angle");
                Close(shifted.ElTop, normal.ElTop - 5, 1e-9, "CalV top world angle");
                Close(shifted.ElBot, normal.ElBot - 5, 1e-9, "CalV bottom world angle");
            }
        }

        static void TestCacheKey()
        {
            var a = new DualFrameCacheKey(1, 2, 3, "A.jpg", "dataset");
            Check(a.Equals(new DualFrameCacheKey(1, 2, 3, "a.jpg", "dataset")), "frame name case insensitive");
            Check(!a.Equals(new DualFrameCacheKey(1, 2, 4, "A.jpg", "dataset")), "CalV changes cache key");
            Check(!a.Equals(new DualFrameCacheKey(1, 2, 3, "B.jpg", "dataset")), "primary frame changes cache key");
        }

        static void TestFallbackWithoutAxis()
        {
            var tree = new UtmTree { Id = 1, X = 0, Y = 10, Z = 0, Height = 5 };
            var frame = new FrameInfo { Name = "a" };
            var ctx = new DualFrameContext {
                MetaPose = new Dictionary<string, double[]> {
                    { "a", new double[] { 0, 0, 1.5, 0, 0, 0 } }
                }
            };
            var input = new DualFrameInput { Tree = tree, FrameA = frame, AzA = 0 };
            DualFrameResult fallback = DualFrameEngine.MakeFallback(ctx, input,
                FallbackReason.NoCandidateB, 0, "", double.NaN, 0);
            Close(fallback.AzNew, 0, 1e-9, "missing axis must not apply a fixed global horizontal bias");
        }

        static Bitmap ObservationImage(bool vertical)
        {
            return ObservationImage(vertical, 170, 75);
        }

        static Bitmap ObservationImage(bool vertical, int top, int length)
        {
            var image = new Bitmap(800, 400, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(image))
            {
                g.Clear(Color.FromArgb(140, 180, 140));
                using (var brush = new SolidBrush(Color.FromArgb(60, 40, 30)))
                {
                    if (vertical)
                    {
                        g.FillRectangle(brush, 394, top, 12, length);
                        // 该测试 A/B 两相机到目标等距且等高，绝对图像行对应同一世界高度。
                        // 在相同世界高度加入可重复树皮纹理，避免把纯色杆当成树干对应证据。
                        using (var light = new SolidBrush(Color.FromArgb(101, 73, 48)))
                        using (var dark = new SolidBrush(Color.FromArgb(37, 27, 20)))
                            for (int y = top + 1; y < top + length; y++)
                            {
                                int pattern = (y * 37 + y / 7) % 17;
                                if (pattern < 5) g.FillRectangle(light, 396 + pattern % 3, y, 7, 1);
                                else if (pattern > 13) g.FillRectangle(dark, 397, y, 6, 1);
                            }
                    }
                    else g.FillRectangle(brush, 0, 195, 800, 35);
                }
            }
            return image;
        }

        static void TestMultipleSecondaryFrames()
        {
            var frames = new List<FrameInfo> {
                new FrameInfo { Name = "a" }, new FrameInfo { Name = "bad" },
                new FrameInfo { Name = "good" }, new FrameInfo { Name = "bad" },
                new FrameInfo { Name = "last" }, new FrameInfo { Name = "A" }
            };
            var poses = new Dictionary<string, double[]> {
                { "a", new double[] { 0, 0, 1.5, 0, 0, 0 } },
                { "bad", new double[] { 10, 10, 1.5, 0, 0, 0 } },
                { "good", new double[] { -10, 10, 1.5, 0, 0, 0 } },
                { "last", new double[] { 10, 20, 1.5, 0, 0, 0 } }
            };
            var tree = new UtmTree { Id = 1, X = 0, Y = 10, Z = 0, Height = 5 };
            var a = new FrameCandidate { Index = 0, Dh = 10, AzT = 0, A0 = -180, ElB = -40, ElT = 40 };
            var candidates = new List<FrameCandidate> {
                a,
                new FrameCandidate { Index = 1, Dh = 10, AzT = 270, A0 = 90, ElB = -40, ElT = 40 },
                new FrameCandidate { Index = 2, Dh = 10, AzT = 90, A0 = -90, ElB = -40, ElT = 40 },
                new FrameCandidate { Index = 3, Dh = 10, AzT = 270, A0 = 90, ElB = -40, ElT = 40 },
                new FrameCandidate { Index = 4, Dh = Math.Sqrt(200), AzT = 225, A0 = 45, ElB = -40, ElT = 40 },
                new FrameCandidate { Index = 5, Dh = 10, AzT = 270, A0 = 90, ElB = -40, ElT = 40 }
            };
            var input = new DualFrameInput {
                Tree = tree, FrameA = frames[0], CandA = a, Candidates = candidates,
                Cache = new Dictionary<DualFrameCacheKey, DualFrameResult>()
            };
            var reads = new List<string>();
            var ctx = new DualFrameContext {
                Enabled = true, Frames = frames, MetaPose = poses,
                SegmentOf = delegate { return 1; },
                TrunkAxisOf = delegate { return new double[] { 0, 10 }; },
                ProjectPrimary = ProjectTestPhoto,
                LoadSmallFrame = delegate(string name) {
                    reads.Add(name);
                    return ObservationImage(name == "a" || name == "good");
                }
            };
            bool hit; int loads;
            DualFrameResult result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(result.Status == DualFrameStatus.Success, "second secondary can succeed");
            Check(result.FrameB == "good" && result.PairAttempts == 2, "actual selected B and attempt count");
            Check(loads == 3 && reads.Count == 3 && reads[0] == "a" && reads[1] == "bad" && reads[2] == "good",
                  "primary read once and duplicate secondary not reread");
            result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(hit && loads == 0 && result.FrameB == "good", "successful pair cached");

            ctx.CalV = 1;
            result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(!hit && loads > 0, "changing CalV recomputes instead of reusing old observations");
            ctx.CalV = 0;

            input.Cache.Clear();
            reads.Clear();
            ctx.LoadSmallFrame = delegate(string name) {
                reads.Add(name);
                return name == "bad" ? ObservationImage(true, 250, 25) : ObservationImage(true);
            };
            result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(result.Status == DualFrameStatus.Success && result.FrameB == "good" && result.PairAttempts == 2,
                  "unsupported first B falls through to valid second B");

            input.Cache.Clear();
            reads.Clear();
            ctx.LoadSmallFrame = delegate(string name) { reads.Add(name); return ObservationImage(false); };
            result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(result.Reason == FallbackReason.PrimaryObservationFailed, "primary failure is explicit");
            Check(loads == 1 && reads.Count == 1 && reads[0] == "a", "primary failure does not load B");

            input.Cache.Clear();
            reads.Clear();
            ctx.LoadSmallFrame = delegate(string name) { reads.Add(name); return ObservationImage(name == "a"); };
            result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(result.Reason == FallbackReason.SecondaryObservationFailed, "all secondary failures are explicit");
            Check(result.PairAttempts == 3 && loads == 4 && reads.Count == 4, "at most three unique B frames");
            Check(reads.FindAll(delegate(string name) { return name == "bad"; }).Count == 1,
                  "duplicate names are not counted as separate views");
            Check(reads.FindAll(delegate(string name) { return string.Equals(name, "a", StringComparison.OrdinalIgnoreCase); }).Count == 1,
                  "same primary image with different name case cannot become B");

            input.Cache.Clear();
            reads.Clear();
            ctx.Enabled = false;
            result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(result.Status == DualFrameStatus.Disabled && loads == 0 && reads.Count == 0,
                  "disabled analysis reads no images");
            ctx.Enabled = true;
            ctx.Manual = true;
            result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(result.Status == DualFrameStatus.ManualSkipped && loads == 0 && reads.Count == 0,
                  "manual annotation takes priority without image reads");

            ctx.Manual = false;
            ctx.LoadSmallFrame = delegate(string name) { reads.Add(name); return ObservationImage(name == "a" || name == "good"); };
            input.Cache.Clear();
            reads.Clear();
            DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            input.FrameA = frames[2];
            input.CandA = candidates[2];
            reads.Clear();
            result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(!hit && loads > 0 && reads.Count > 0 && reads[0] == "good",
                  "changing the primary frame cannot reuse previous primary observations");
        }

        static double[] ProjectTestPhoto(double az, double el)
        {
            double x, y;
            Proj.PixelFromWorld(az, el, 0, 0, Proj.HalfScale(60), Proj.HalfScale(48), 0, out x, out y);
            return new double[] { x, y };
        }

        static void TestSecondaryRetryDiversity()
        {
            var frames = new List<FrameInfo> {
                new FrameInfo { Name = "a" }, new FrameInfo { Name = "bad" },
                new FrameInfo { Name = "near-repeat" }, new FrameInfo { Name = "other-side" }
            };
            var poses = new Dictionary<string, double[]> {
                { "a", new double[] { 0, 0, 1.5, 0, 0, 0 } },
                { "bad", new double[] { 10, 10, 1.5, 0, 0, 0 } },
                { "near-repeat", new double[] { 10, 11, 1.5, 0, 0, 0 } },
                { "other-side", new double[] { -10, 10, 1.5, 0, 0, 0 } }
            };
            double repeatAz = Geo.Wrap360(Geo.Deg(Math.Atan2(-10, -1)));
            var candidates = new List<FrameCandidate> {
                new FrameCandidate { Index = 0, Dh = 10, AzT = 0, A0 = -180, ElB = -40, ElT = 40 },
                new FrameCandidate { Index = 1, Dh = 10, AzT = 270, A0 = 90, ElB = -40, ElT = 40 },
                new FrameCandidate { Index = 2, Dh = Math.Sqrt(101), AzT = repeatAz, A0 = repeatAz - 180, ElB = -40, ElT = 40 },
                new FrameCandidate { Index = 3, Dh = 10, AzT = 90, A0 = -90, ElB = -40, ElT = 40 }
            };
            var reads = new List<string>();
            var ctx = new DualFrameContext {
                Enabled = true, Frames = frames, MetaPose = poses,
                SegmentOf = delegate { return 1; },
                TrunkAxisOf = delegate { return new double[] { 0, 10 }; },
                ProjectPrimary = ProjectTestPhoto,
                LoadSmallFrame = delegate(string name) {
                    reads.Add(name);
                    return ObservationImage(name != "bad");
                }
            };
            var input = new DualFrameInput {
                Tree = new UtmTree { Id = 1, X = 0, Y = 10, Z = 0, Height = 5 },
                FrameA = frames[0], CandA = candidates[0], Candidates = candidates,
                Cache = new Dictionary<DualFrameCacheKey, DualFrameResult>()
            };
            bool hit; int loads;
            DualFrameResult result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
            Check(reads.Count >= 3 && reads[0] == "a" && reads[1] == "bad" && reads[2] == "other-side",
                  "after failure, try a distinct viewpoint before a near-duplicate B");
            Check(loads <= 4 && result.PairAttempts <= 3, "retry budget remains bounded");
            Check(result.Status != DualFrameStatus.Success || result.FrameB == "other-side",
                  "any success must report the actual verified B");
        }

        internal static int Run()
        {
            try
            {
                TestNearestFrame();
                TestCameraPoseValidation();
                TestCommonSegment();
                TestHorizontalIntersection();
                TestCandidateBaseline();
                TestFlightSegments();
                TestObservationAndCalibration();
                TestCacheKey();
                TestFallbackWithoutAxis();
                TestMultipleSecondaryFrames();
                TestSecondaryRetryDiversity();
                Console.WriteLine("PASS " + checks + " dual-frame/nearest-frame checks");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex);
                return 1;
            }
        }
    }
}
