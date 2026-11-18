using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;

namespace TreeExtractor
{
    internal static class QAGeometryTests
    {
        static int _checks;
        static int _failures;

        static void Check(bool ok, string name)
        {
            _checks++;
            Console.WriteLine((ok ? "PASS " : "FAIL ") + name);
            if (!ok) _failures++;
        }

        static bool Near(double a, double b, double tolerance)
        {
            return !double.IsNaN(a) && !double.IsInfinity(a) && Math.Abs(a - b) <= tolerance;
        }

        static void CheckAngle(double theta, bool expected)
        {
            double angle = Geo.Rad(theta);
            double[] a = { 0, -10, 1.5, 0, 0, 0 };
            double[] b = { -10 * Math.Sin(angle), -10 * Math.Cos(angle), 1.5, 0, 0, 0 };
            double x, y;
            bool crossing = DualFrameGeometry.TryIntersectHorizontal(a, 0, b, theta, out x, out y);
            Check(crossing == expected && (!crossing || (Near(x, 0, 1e-6) && Near(y, 0, 1e-6))),
                  "horizontal-intersection angle=" + theta);

            var frameA = new FrameInfo { Name = "a.jpg" };
            var frameB = new FrameInfo { Name = "b.jpg" };
            var candA = new FrameCandidate { Index = 0, Dh = 10, AzT = 0 };
            var candB = new FrameCandidate { Index = 1, Dh = 10, AzT = theta };
            var context = new DualFrameContext {
                Frames = new List<FrameInfo> { frameA, frameB },
                MetaPose = new Dictionary<string, double[]> { { "a.jpg", a }, { "b.jpg", b } },
                SegmentOf = delegate(string name) { return 0; }
            };
            var input = new DualFrameInput {
                Tree = new UtmTree { Id = 1, X = 0, Y = 0, Height = 10 },
                FrameA = frameA, CandA = candA, Candidates = new List<FrameCandidate> { candA, candB }
            };
            FallbackReason reason;
            double baseline;
            FrameCandidate chosen = DualFrameEngine.SelectB(context, input, out reason, out baseline);
            Check((chosen != null) == expected, "select-B angle=" + theta + " baseline=" + baseline);
        }

        static void CommonHeightTests()
        {
            var a = new TrunkMeasure { ZBot = -2, ZTop = 3 };
            var b = new TrunkMeasure { ZBot = 1, ZTop = 12 };
            double low, high, middle;
            bool found = DualFrameGeometry.TryCommonVisibleHeight(a, b, 8, out low, out high, out middle);
            Check(found && Near(low, 1, 1e-9) && Near(high, 3, 1e-9) && Near(middle, 2, 1e-9),
                  "common visible interval clipped to tree height");
            b.ZBot = 3.5;
            Check(!DualFrameGeometry.TryCommonVisibleHeight(a, b, 8, out low, out high, out middle),
                  "disjoint visible intervals rejected");
            b.ZBot = 2.95;
            Check(!DualFrameGeometry.TryCommonVisibleHeight(a, b, 8, out low, out high, out middle),
                  "insufficient overlap rejected");
            b.ZBot = double.NaN;
            Check(!DualFrameGeometry.TryCommonVisibleHeight(a, b, 8, out low, out high, out middle),
                  "non-finite visible height rejected");

            // A sees a long trunk while B only sees the lower end: common midpoint is not A's midpoint.
            a.ZBot = 0.2; a.ZTop = 2.0;
            b.ZBot = 0.2; b.ZTop = 0.7;
            Check(!DualFrameGeometry.TryPrimaryVisibleMidpoint(a, b, 3, out low, out high, out middle),
                  "B cannot confirm A midpoint under asymmetric occlusion");
            b.ZTop = 1.6;
            found = DualFrameGeometry.TryPrimaryVisibleMidpoint(a, b, 3, out low, out high, out middle);
            Check(found && Near(middle, 1.1, 1e-9) && middle >= low && middle <= high,
                  "primary visible midpoint used when B also sees it");
        }

        static Bitmap SyntheticImage(bool horizontalStripes, bool trunk, double calV)
        {
            const int width = 1440, height = 720;
            var image = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (Graphics graphics = Graphics.FromImage(image))
            {
                graphics.Clear(Color.FromArgb(210, 225, 210));
                if (horizontalStripes)
                {
                    using (var brush = new SolidBrush(Color.FromArgb(60, 50, 40)))
                        for (int y = 0; y < height; y += 20) graphics.FillRectangle(brush, 0, y, width, 10);
                }
                if (trunk)
                {
                    double elTop = Geo.Deg(Math.Atan2(5.0 - 1.5, 10));
                    double elBot = Geo.Deg(Math.Atan2(1.0 - 1.5, 10));
                    int yTop = (int)Math.Round((90 - elTop - calV) / 180.0 * height);
                    int yBot = (int)Math.Round((90 - elBot - calV) / 180.0 * height);
                    using (var brush = new SolidBrush(Color.FromArgb(80, 45, 25)))
                        graphics.FillRectangle(brush, 712, yTop, 16, yBot - yTop + 1);
                }
            }
            return image;
        }

        static bool Measure(Bitmap image, double calV, out TrunkMeasure result)
        {
            var tree = new UtmTree { Id = 1, X = 0, Y = -10, Z = 0, Height = 10 };
            var candidate = new FrameCandidate {
                Index = 0, Dh = 10, AzT = 180, A0 = 0,
                ElB = Geo.Deg(Math.Atan2(-1.5, 10)),
                ElT = Geo.Deg(Math.Atan2(8.5, 10))
            };
            double[] camera = { 0, 0, 1.5, 0, 0, 0 };
            return TrunkObservation.MeasureEx(image, tree, candidate, camera, 0, calV, out result);
        }

        static void ObservationTests()
        {
            TrunkMeasure m;
            using (Bitmap blank = SyntheticImage(false, false, 0))
                Check(!Measure(blank, 0, out m), "uniform image does not invent a trunk");
            using (Bitmap stripes = SyntheticImage(true, false, 0))
                Check(!Measure(stripes, 0, out m), "horizontal stripes do not invent a trunk");
            TrunkMeasure ordinary, shifted;
            bool okOrdinary, okShifted;
            using (Bitmap image = SyntheticImage(false, true, 0)) okOrdinary = Measure(image, 0, out ordinary);
            using (Bitmap image = SyntheticImage(false, true, 10)) okShifted = Measure(image, 10, out shifted);
            Check(okOrdinary && okShifted, "detect synthetic vertical trunk at both CalV values");
            if (okOrdinary && okShifted)
            {
                Check(Near(ordinary.AzPix, shifted.AzPix, 0.1), "CalV preserves observed bearing");
                Check(Near(ordinary.ElPix, shifted.ElPix, 0.3), "CalV preserves observed midpoint elevation");
                Check(Near(ordinary.ZBot, shifted.ZBot, 0.1) && Near(ordinary.ZTop, shifted.ZTop, 0.1),
                      "CalV preserves observed vertical interval");
                Check(ordinary.ZBot < ordinary.ZTop, "detected trunk segment has ordered endpoints");
            }
        }

        internal static int Run()
        {
            foreach (double angle in new[] { 0.0, 5.0, 14.99, 15.0, 15.01, 90.0, 164.99, 165.0, 165.01, 175.0, 180.0 })
                CheckAngle(angle, angle >= 15.0 && angle <= 165.0);
            CommonHeightTests();
            ObservationTests();
            Console.WriteLine("CHECKS=" + _checks + " FAILURES=" + _failures);
            return _failures == 0 ? 0 : 1;
        }
    }
}
