using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace TreeExtractor
{
    /// <summary>
    /// 三维合成真值回归：从已知相机与树干位置生成全景图，
    /// 不把“双帧返回成功”直接等同于定位正确。
    /// </summary>
    internal static class DualFramePhysicalTests
    {
        const int Width = 1440, Height = 720;
        const double AxisX = 0.0, AxisY = 0.0;
        static int checks;

        static void Check(bool ok, string message)
        {
            checks++;
            if (!ok) throw new Exception(message);
        }

        static void Near(double actual, double expected, double tolerance, string message)
        {
            Check(!double.IsNaN(actual) && !double.IsInfinity(actual) &&
                  Math.Abs(actual - expected) <= tolerance,
                  message + ": actual=" + actual + " expected=" + expected + " tolerance=" + tolerance);
        }

        static double Azimuth(double x, double y, double[] camera)
        {
            return Geo.Wrap360(Geo.Deg(Math.Atan2(x - camera[0], y - camera[1])));
        }

        static double Elevation(double z, double[] camera, double horizontalDistance)
        {
            return Geo.Deg(Math.Atan2(z - camera[2], horizontalDistance));
        }

        static BackendSession SessionWithForest(UtmForest forest, Dictionary<int, double[]> axes)
        {
            var session = new BackendSession();
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
            FieldInfo forestField = typeof(BackendSession).GetField("_utmForest", flags);
            FieldInfo axesField = typeof(BackendSession).GetField("_trunkXy", flags);
            if (forestField == null || axesField == null) throw new Exception("测试无法注入隔离树木数据");
            forestField.SetValue(session, forest);
            axesField.SetValue(session, axes);
            return session;
        }

        static FrameCandidate Candidate(int index, double[] camera, UtmTree tree, double reference)
        {
            double dx = AxisX - camera[0], dy = AxisY - camera[1];
            double dh = Math.Sqrt(dx * dx + dy * dy);
            return new FrameCandidate {
                Index = index, Dh = dh, AzT = Azimuth(AxisX, AxisY, camera), A0 = reference,
                ElA = Elevation(tree.Z + Math.Min(tree.Height * 0.3, 1.8), camera, dh),
                ElB = Elevation(tree.Z, camera, dh), ElT = Elevation(tree.Z + tree.Height, camera, dh)
            };
        }

        static void RectWrapped(Graphics graphics, Brush brush, int x, int y, int width, int height)
        {
            graphics.FillRectangle(brush, x, y, width, height);
            if (x < 0) graphics.FillRectangle(brush, x + Width, y, width, height);
            if (x + width >= Width) graphics.FillRectangle(brush, x - Width, y, width, height);
        }

        static Bitmap Panorama(double[] camera, double reference, double verticalCal,
                               double targetX, double targetY, double zBottom, double zTop,
                               bool showTrunk, bool obscureMiddle, int textureMode, int seed)
        {
            var image = new Bitmap(Width, Height, PixelFormat.Format24bppRgb);
            using (Graphics graphics = Graphics.FromImage(image))
            {
                graphics.Clear(Color.FromArgb(156, 191, 150));
                // 相同类绿色背景与确定性纹理，避免使用纯黑白竖线作为唯一正例。
                var random = new Random(seed);
                using (var foliage1 = new SolidBrush(Color.FromArgb(130, 166, 125)))
                using (var foliage2 = new SolidBrush(Color.FromArgb(169, 198, 154)))
                    for (int i = 0; i < 1800; i++)
                        graphics.FillEllipse(i % 2 == 0 ? foliage1 : foliage2,
                                             random.Next(Width), random.Next(Height),
                                             4 + random.Next(12), 3 + random.Next(9));
                if (showTrunk)
                {
                    double az = Azimuth(targetX, targetY, camera);
                    double dh = Geo.Dist2D(targetX - camera[0], targetY - camera[1]);
                    double column = Geo.Wrap360(az - reference) / 360.0 * Width;
                    int yTop = (int)Math.Round((90.0 - Elevation(zTop, camera, dh) - verticalCal) / 180.0 * Height);
                    int yBot = (int)Math.Round((90.0 - Elevation(zBottom, camera, dh) - verticalCal) / 180.0 * Height);
                    int left = (int)Math.Round(column) - 7;
                    int top = Math.Min(yTop, yBot), length = Math.Abs(yBot - yTop) + 1;
                    using (var bark = new SolidBrush(Color.FromArgb(71, 54, 37)))
                    using (var barkLight = new SolidBrush(Color.FromArgb(105, 78, 53)))
                    using (var barkDark = new SolidBrush(Color.FromArgb(45, 34, 27)))
                    {
                        RectWrapped(graphics, bark, left, top, 14, length);
                        if (textureMode != 2)
                            for (int mark = 1; mark <= 80; mark++)
                            {
                                // 纹理由世界高度决定，而非像素行；两台相机对应的是同一 3D 树干。
                                double worldZ = mark * (5.0 / 81.0);
                                if (worldZ < zBottom || worldZ > zTop) continue;
                                int y = (int)Math.Round((90.0 - Elevation(worldZ, camera, dh)
                                                         - verticalCal) / 180.0 * Height);
                                int pattern = textureMode == 0 ? mark * 37 % 11 : mark * 19 % 11;
                                int offset = pattern % 5;
                                RectWrapped(graphics, pattern < 5 ? barkLight : barkDark,
                                            left + 2 + offset, y, 7, 2);
                            }
                    }
                    if (obscureMiddle)
                    {
                        // 用前景叶片遮住中间一段，不能把不相连的两段虚构为连续可见树干。
                        using (var leaf = new SolidBrush(Color.FromArgb(118, 158, 105)))
                            RectWrapped(graphics, leaf, left - 5, top + length * 2 / 5,
                                        22, Math.Max(5, length / 5));
                    }
                }
            }
            return image;
        }

        sealed class Fixture
        {
            public readonly UtmTree Tree = new UtmTree { Id = 1, X = 0.22, Y = -0.16, Z = 0, Height = 5 };
            public readonly double[] A = { -6, -6, 1.4, 0, 0, 0 };
            public readonly double[] B = { 7, -6, 1.7, 0, 0, 0 };
            public readonly List<FrameInfo> Frames = new List<FrameInfo> {
                new FrameInfo { Name = "primary.jpg" }, new FrameInfo { Name = "secondary.jpg" }
            };
            public FrameCandidate Ca, Cb;
            public double VerticalCal;
            public double PhotoBearing, PhotoElevation, PhotoHfov, PhotoVfov, PhotoShift;
            public double PrimaryBottom = 0.3, PrimaryTop = 2.0;

            public Fixture(double calV, bool crossesSeam, bool close = false)
            {
                if (close)
                {
                    Tree.X = AxisX; Tree.Y = AxisY;
                    A[0] = 0; A[1] = -0.8; A[2] = 1.5;
                    B[0] = 2.8; B[1] = 0; B[2] = 1.5;
                    PrimaryBottom = 0.0; PrimaryTop = 3.5;
                }
                VerticalCal = calV;
                double azA = Azimuth(AxisX, AxisY, A), azB = Azimuth(AxisX, AxisY, B);
                Ca = Candidate(0, A, Tree, crossesSeam ? azA + 1.0 : azA - 180.0);
                Cb = Candidate(1, B, Tree, azB - 180.0);
                PhotoBearing = Azimuth(Tree.X, Tree.Y, A);
                PhotoElevation = 0.0;
                PhotoVfov = close ? 120.0 : 80.0;
                PhotoHfov = Proj.Hfov(PhotoVfov, 4.0 / 3.0);
                PhotoShift = 0.0;
            }

            public double[] Project(double az, double el)
            {
                double x, y;
                Proj.PixelFromWorld(az, el, PhotoBearing, PhotoElevation,
                                    Proj.HalfScale(PhotoHfov / 2.0),
                                    Proj.HalfScale(PhotoVfov / 2.0), PhotoShift, out x, out y);
                return new double[] { x, y };
            }

            public DualFrameResult Analyze(bool showA, bool showB, bool obscureA, bool obscureB,
                                           double bx, double by, double bBottom, double bTop,
                                           int aTexture = 0, int bTexture = 0,
                                           bool hasNeighbor = false, bool provideProjection = true,
                                           bool provideOperatorGuard = true, bool checkCache = false,
                                           bool nonOpaquePrimary = false)
            {
                var forest = new UtmForest();
                forest.Trees.Add(Tree);
                if (hasNeighbor) forest.Trees.Add(new UtmTree { Id = 2, X = 1, Y = 1, Z = 0, Height = 5 });
                var axes = new Dictionary<int, double[]> { { Tree.Id, new double[] { AxisX, AxisY } } };
                using (BackendSession backend = SessionWithForest(forest, axes))
                {
                    var ctx = new DualFrameContext {
                        Enabled = true, Frames = Frames, Cal = 0, CalV = VerticalCal,
                        DataSetId = "synthetic-dataset",
                        MetaPose = new Dictionary<string, double[]> { { Frames[0].Name, A }, { Frames[1].Name, B } },
                        TrunkAxisOf = delegate(UtmTree tree) {
                            return tree.Id == Tree.Id ? new double[] { AxisX, AxisY } : new double[] { tree.X, tree.Y };
                        },
                        ProjectPrimary = provideProjection ? Project : null,
                        AxisConflictsNeighbor = backend.AxisConflictsNeighbor,
                        ObservationAtOperatorRisk = provideOperatorGuard ? BackendSession.ObservationAtOperatorRisk : null,
                        SegmentOf = delegate { return 1; },
                        LoadSmallFrame = delegate(string name) {
                            Bitmap image = name == Frames[0].Name
                                ? Panorama(A, Ca.A0, VerticalCal, AxisX, AxisY, PrimaryBottom, PrimaryTop, showA, obscureA, aTexture, 1701)
                                : Panorama(B, Cb.A0, VerticalCal, bx, by, bBottom, bTop, showB, obscureB, bTexture, 1702);
                            if (nonOpaquePrimary && name == Frames[0].Name)
                            {
                                var copy = new Bitmap(Width, Height, PixelFormat.Format32bppArgb);
                                using (Graphics g = Graphics.FromImage(copy)) g.DrawImageUnscaled(image, 0, 0);
                                image.Dispose();
                                copy.SetPixel(0, 0, Color.Transparent);
                                return copy;
                            }
                            return image;
                        }
                    };
                    var input = new DualFrameInput {
                        Tree = Tree, FrameA = Frames[0], CandA = Ca,
                        Candidates = new List<FrameCandidate> { Ca, Cb },
                        AzA = Ca.AzT, AzOld = Ca.AzT, ElOld = -5.0,
                        Cache = new Dictionary<DualFrameCacheKey, DualFrameResult>()
                    };
                    bool hit; int loads;
                    DualFrameResult result = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
                    if (checkCache)
                    {
                        Check(!hit && result.Status == DualFrameStatus.Success && result.Evidence != null,
                              "首次合成成功应记录实际配对图证");
                        VerifyWinningPair(ctx, input, result);
                        DualFrameResult cached = DualFrameEngine.Prepare(ctx, input, out hit, out loads);
                        Check(hit && loads == 0 && ReferenceEquals(result, cached) &&
                              ReferenceEquals(result.Evidence, cached.Evidence), "缓存应保留同一次实际观测");
                    }
                    return result;
                }
            }

            void VerifyWinningPair(DualFrameContext ctx, DualFrameInput input, DualFrameResult result)
            {
                List<TrunkMeasure> aa, bb;
                using (Bitmap imageA = ctx.LoadSmallFrame(Frames[0].Name))
                using (Bitmap imageB = ctx.LoadSmallFrame(Frames[1].Name))
                {
                    aa = TrunkAppearance.Candidates(imageA, Tree, Ca, A, 0, VerticalCal);
                    bb = TrunkAppearance.Candidates(imageB, Tree, Cb, B, 0, VerticalCal);
                }
                aa.RemoveAll(m => ctx.ObservationAtOperatorRisk != null && ctx.ObservationAtOperatorRisk(Ca, m));
                bb.RemoveAll(m => ctx.ObservationAtOperatorRisk != null && ctx.ObservationAtOperatorRisk(Cb, m));
                MethodInfo method = typeof(DualFrameEngine).GetMethod("EvaluatePair",
                    BindingFlags.Static | BindingFlags.NonPublic);
                if (method == null) throw new Exception("无法独立复核候选配对");
                double best = double.NegativeInfinity;
                TrunkMeasure winnerA = new TrunkMeasure(), winnerB = new TrunkMeasure();
                foreach (TrunkMeasure a in aa)
                    foreach (TrunkMeasure b in bb)
                    {
                        var candidate = (DualFrameResult)method.Invoke(null, new object[] {
                            ctx, input, Cb, A, B, a, b, result.BaselineAngleDeg, Frames[1].Name
                        });
                        if (candidate.Status == DualFrameStatus.Success && candidate.Confidence > best)
                        {
                            best = candidate.Confidence; winnerA = a; winnerB = b;
                        }
                    }
                Check(!double.IsNegativeInfinity(best), "合成场景应能独立枚举出成功配对");
                Check(SameObservation(result.Evidence.A, winnerA) && SameObservation(result.Evidence.B, winnerB),
                      "图证必须逐字段等于真实胜出候选，而非其他候选或最终红圈");
            }

            static bool SameObservation(DualFrameObservationEvidence evidence, TrunkMeasure measure)
            {
                return evidence != null && evidence.AzimuthDeg.Equals(measure.AzPix) &&
                       evidence.ElevationTopDeg.Equals(measure.ElTop) &&
                       evidence.ElevationBottomDeg.Equals(measure.ElBot) &&
                       evidence.WidthDeg.Equals(measure.WidthDeg);
            }
        }

        static void IdealPair(bool seam, double calV)
        {
            var f = new Fixture(calV, seam);
            DualFrameResult result = f.Analyze(true, true, false, false, AxisX, AxisY, 0.3, 2.0,
                                               0, 0, false, true, true, true);
            Console.WriteLine("SYNTHETIC ideal seam=" + seam + " calV=" + calV +
                              " status=" + result.Status + " reason=" + result.Reason +
                              " az=" + result.AzNew + " height=" + result.HeightM);
            Check(result.Status == DualFrameStatus.Success,
                  "清晰同树双帧应能验证：" + result.Reason + " seam=" + seam + " CalV=" + calV);
            Check(result.FrameB == f.Frames[1].Name, "必须使用不同辅助照片");
            Near(Geo.Wrap180(result.AzNew - Azimuth(AxisX, AxisY, f.A)), 0, 0.6, "方位真值");
            Near(result.HeightM, 1.15, 0.20, "可见段世界高度中点真值");
            Check(result.Evidence != null && result.Evidence.A != null && result.Evidence.B != null,
                  "合成成功必须携带 A/B 原始观测图证");
            Check(result.Evidence.Attempt == result.PairAttempts && result.Evidence.A.Frame == f.Frames[0].Name &&
                  result.Evidence.B.Frame == f.Frames[1].Name, "图证必须绑定实际成功尝试与 A/B 帧");
            Near(Geo.Wrap180(result.Evidence.A.AzimuthDeg - Azimuth(AxisX, AxisY, f.A)), 0, 0.6,
                 "A 观测方位必须对应合成真值");
            Near(Geo.Wrap180(result.Evidence.B.AzimuthDeg - Azimuth(AxisX, AxisY, f.B)), 0, 0.6,
                 "B 观测方位必须对应合成真值");
            Check(result.Evidence.MatchesSelection(f.Tree, "synthetic-dataset", f.Frames[0].Name,
                  f.Frames[1].Name, result.PairAttempts, 0, calV, false, 0), "图证应匹配同一选择");
            Check(!result.Evidence.MatchesSelection(new UtmTree { Id = f.Tree.Id }, "synthetic-dataset",
                  f.Frames[0].Name, f.Frames[1].Name, result.PairAttempts, 0, calV, false, 0),
                  "相同 ID 的其他树对象不能复用图证");
            Check(!result.Evidence.MatchesSelection(f.Tree, "other", f.Frames[0].Name,
                  f.Frames[1].Name, result.PairAttempts, 0, calV, false, 0), "不同数据集不能复用图证");
            Check(!result.Evidence.MatchesSelection(f.Tree, "synthetic-dataset", "other.jpg",
                  f.Frames[1].Name, result.PairAttempts, 0, calV, false, 0), "切换主帧不能复用图证");
            Check(!result.Evidence.MatchesSelection(f.Tree, "synthetic-dataset", f.Frames[0].Name,
                  f.Frames[1].Name, result.PairAttempts + 1, 0, calV, false, 0), "不同尝试不能复用图证");
            Check(!result.Evidence.MatchesSelection(f.Tree, "synthetic-dataset", f.Frames[0].Name,
                  "other.jpg", result.PairAttempts, 0, calV, false, 0), "不同辅助帧不能复用图证");
            Check(!result.Evidence.MatchesSelection(f.Tree, "synthetic-dataset", f.Frames[0].Name,
                  f.Frames[1].Name, result.PairAttempts, 0.1, calV, false, 0), "不同水平校正不能复用图证");
            Check(!result.Evidence.MatchesSelection(f.Tree, "synthetic-dataset", f.Frames[0].Name,
                  f.Frames[1].Name, result.PairAttempts, 0, calV + 1, false, 0), "不同垂直校正不能复用图证");
            Check(!result.Evidence.MatchesSelection(f.Tree, "synthetic-dataset", f.Frames[0].Name,
                  f.Frames[1].Name, result.PairAttempts, 0, calV, true, 0), "不同视图模式不能复用图证");
            Check(!result.Evidence.MatchesSelection(f.Tree, "synthetic-dataset", f.Frames[0].Name,
                  f.Frames[1].Name, result.PairAttempts, 0, calV, false, 1), "不同投影不能复用图证");
            using (Bitmap image = Panorama(f.A, f.Ca.A0, calV, AxisX, AxisY, 0.3, 2.0, true, false, 0, 1701))
            {
                Check(DualFrameImageEvidence.Matches(image, result.Evidence.A), "重读的原始 A 缩图必须逐像素一致");
                string url = DualFrameImageEvidence.PngDataUrl(image, result.Evidence.A.AnalysisPixelSha256);
                Check(url.StartsWith("data:image/png;base64,"), "无标记图必须为无损 PNG");
                image.SetPixel(0, 0, Color.Red);
                Check(!DualFrameImageEvidence.Matches(image, result.Evidence.A), "原图任一像素被篡改必须拒绝图证");
            }
            if (seam) Check(result.Evidence.A.X > 0.98, "全景接缝观测必须环绕到画面右端");
        }

        static void NegativeCases()
        {
            var f = new Fixture(0.0, false);
            DualFrameResult empty = f.Analyze(false, false, false, false, AxisX, AxisY, 0.3, 2.0);
            Check(empty.Status != DualFrameStatus.Success, "两帧均无树干时不得假成功");
            Check(empty.Evidence == null, "回退态不得留有此前的成功观测图证");
            DualFrameResult missingB = f.Analyze(true, false, false, false, AxisX, AxisY, 0.3, 2.0);
            Check(missingB.Status != DualFrameStatus.Success, "辅助帧没有树干时不得假成功");
            DualFrameResult flatPoles = f.Analyze(true, true, false, false, AxisX, AxisY, 0.3, 2.0, 2, 2);
            Check(flatPoles.Status != DualFrameStatus.Success, "同色无纹理竖杆不能证明是同一树干");
            DualFrameResult differentTexture = f.Analyze(true, true, false, false, AxisX, AxisY, 0.3, 2.0, 0, 1);
            Check(differentTexture.Status != DualFrameStatus.Success, "同色但纹理不一致不能冒充同一树干");
            f.PrimaryBottom = 0.0; f.PrimaryTop = 4.8;
            DualFrameResult longFlat = f.Analyze(true, true, false, false, AxisX, AxisY, 0.0, 4.8, 2, 2);
            Check(longFlat.Status != DualFrameStatus.Success, "长的无纹理竖杆仍不能冒充同一树干");
            DualFrameResult longMismatch = f.Analyze(true, true, false, false, AxisX, AxisY, 0.0, 4.8, 0, 1);
            Check(longMismatch.Status != DualFrameStatus.Success, "长树干的纹理不一致仍必须回退");
            f.PrimaryBottom = 0.3; f.PrimaryTop = 2.0;
            DualFrameResult mismatch = f.Analyze(true, true, false, false, 3.0, -2.3, 0.3, 2.0);
            Check(mismatch.Status != DualFrameStatus.Success, "另一位置的树干不能当成同一棵树");
            // A 的真实树干与邻树正好共线；B 却观测到邻树，错误交点落在旧版轴心容差内。
            DualFrameResult neighbor = f.Analyze(true, true, false, false, 1.0, 1.0, 0.3, 2.0,
                                                0, 0, true);
            Check(neighbor.Status != DualFrameStatus.Success, "更接近已知邻树的配对不得报目标成功");
            DualFrameResult hiddenMid = f.Analyze(true, true, false, false, AxisX, AxisY, 0.30, 0.75);
            Check(hiddenMid.Status != DualFrameStatus.Success, "辅助帧未覆盖主帧中点时不得假成功");
            DualFrameResult unknownProjection = f.Analyze(true, true, false, false, AxisX, AxisY,
                                                         0.3, 2.0, 0, 0, false, false);
            Check(unknownProjection.Status != DualFrameStatus.Success, "无真实 4:3 投影时不得伪称画面中点成功");
            DualFrameResult blocked = f.Analyze(true, true, true, false, AxisX, AxisY, 0.3, 2.0);
            if (blocked.Status == DualFrameStatus.Success)
            {
                double dh = f.Ca.Dh;
                double yTop = (90.0 - Elevation(2.0, f.A, dh)) / 180.0 * Height;
                double yBottom = (90.0 - Elevation(0.3, f.A, dh)) / 180.0 * Height;
                double yMark = (90.0 - blocked.ElNew) / 180.0 * Height;
                double cutFrom = yTop + (yBottom - yTop) * 0.4;
                double cutTo = yTop + (yBottom - yTop) * 0.6;
                Check(yMark < cutFrom - 1 || yMark > cutTo + 1,
                      "成功时红圈不能落到已遮挡的树干中段");
            }
        }

        static void EvidenceFailureDoesNotChangeResult()
        {
            var f = new Fixture(0.0, false);
            DualFrameResult result = f.Analyze(true, true, false, false, AxisX, AxisY, 0.3, 2.0,
                                               0, 0, false, true, true, false, true);
            Check(result.Status == DualFrameStatus.Success,
                  "图证源不透明性不足不得改变原有成功定位状态");
            Check(result.Evidence == null, "图证源不透明性不足时必须拒绝生成图证");
        }

        static void SecondaryPartialOcclusion()
        {
            var f = new Fixture(0.0, false);
            // B 只看到 0.6～1.6m，但覆盖 A 帧屏幕中点；不同可见区间不应强行要求完全一致。
            DualFrameResult result = f.Analyze(true, true, false, false, AxisX, AxisY, 0.6, 1.6);
            Check(result.Status == DualFrameStatus.Success,
                  "辅助帧部分遮挡但覆盖主帧中点应允许可验证结果: " + result.Reason);
            Near(result.HeightM, 1.15, 0.20, "辅助帧部分遮挡时仍用主帧可见段中点");
        }

        static void LongVisibleTrunk()
        {
            var f = new Fixture(0.0, false);
            f.PrimaryBottom = 0.0;
            f.PrimaryTop = 4.8;
            using (Bitmap image = Panorama(f.B, f.Cb.A0, 0, AxisX, AxisY, f.PrimaryBottom,
                                           f.PrimaryTop, true, false, 0, 1702))
            {
                TrunkMeasure oldMeasure, edgeMeasure;
                bool original = TrunkObservation.MeasureEx(image, f.Tree, f.Cb, f.B, 0, 0, out oldMeasure);
                bool supported = TrunkObservation.MeasureEx(image, f.Tree, f.Cb, f.B, 0, 0, true, out edgeMeasure);
                Console.WriteLine("SYNTHETIC long B original=" + original + " edge=" + supported +
                                  " origElev=" + oldMeasure.ElBot + ".." + oldMeasure.ElTop +
                                  " edgeElev=" + edgeMeasure.ElBot + ".." + edgeMeasure.ElTop);
                Check(original && supported, "长树干样例应重现响应段切碎并产生双边缘观测");
                Check((oldMeasure.ElTop - oldMeasure.ElBot) < 2.0, "原响应段仅捕获局部纹理");
                Near(edgeMeasure.ElBot, Elevation(0.0, f.B, f.Cb.Dh), 0.5, "双边缘段下界");
                Near(edgeMeasure.ElTop, Elevation(4.8, f.B, f.Cb.Dh), 0.5, "双边缘段上界");
            }
            DualFrameResult result = f.Analyze(true, true, false, false, AxisX, AxisY,
                                               f.PrimaryBottom, f.PrimaryTop);
            Console.WriteLine("SYNTHETIC long-trunk experiment=" + DualFrameExperimentOptions.EdgeCandidateEnabled +
                              " status=" + result.Status + " reason=" + result.Reason);
            if (DualFrameExperimentOptions.EdgeCandidateEnabled)
            {
                Check(result.Status == DualFrameStatus.Success,
                      "开启实验后清晰长树干应能双帧验证: " + result.Reason);
                Near(Geo.Wrap180(result.AzNew - Azimuth(AxisX, AxisY, f.A)), 0, 0.6, "长树干方位真值");
                Near(result.HeightM, 2.4, 0.30, "长树干可见段中点真值");
            }
            else
            {
                Check(result.Status == DualFrameStatus.Fallback &&
                      result.Reason == FallbackReason.NoCommonVisibleTrunk,
                      "默认关闭实验时长树干应维持原有安全回退");
            }
        }

        static void ExperimentConfiguration(string[] args)
        {
            Check(!DualFrameExperimentOptions.IsExplicitlyEnabled(null), "未设置时实验必须关闭");
            Check(!DualFrameExperimentOptions.IsExplicitlyEnabled(""), "空值不能启用实验");
            Check(!DualFrameExperimentOptions.IsExplicitlyEnabled("true"), "true 不能代替显式的 1");
            Check(!DualFrameExperimentOptions.IsExplicitlyEnabled(" 1"), "带空白的值不能启用实验");
            Check(!DualFrameExperimentOptions.IsExplicitlyEnabled("01"), "01 不能启用实验");
            Check(DualFrameExperimentOptions.IsExplicitlyEnabled("1"), "只有确切的 1 启用实验");
            if (args.Length == 0) return;
            if (args[0] == "expect-disabled")
                Check(!DualFrameExperimentOptions.EdgeCandidateEnabled, "测试进程必须以默认关闭状态启动");
            else if (args[0] == "expect-enabled")
                Check(DualFrameExperimentOptions.EdgeCandidateEnabled, "测试进程必须显式开启实验");
            else throw new ArgumentException("Unknown physical test mode: " + args[0]);
        }

        static void EdgeSegmentNegativeCases()
        {
            const int cols = 41, rows = 80, center = 20;
            var gray = new double[cols * rows];
            for (int i = 0; i < gray.Length; i++) gray[i] = 180.0;
            int start, length;
            Check(!TrunkObservation.TryEdgeSupportedSegment(gray, cols, rows, center, out start, out length),
                  "均匀背景没有双侧边缘");

            for (int y = 10; y < 70; y++)
                for (int x = center; x < cols; x++) gray[y * cols + x] = 50.0;
            Check(!TrunkObservation.TryEdgeSupportedSegment(gray, cols, rows, center, out start, out length),
                  "单侧边缘不能作为树干段");

            for (int i = 0; i < gray.Length; i++) gray[i] = 180.0;
            for (int y = 10; y < 70; y++)
                for (int x = 15; x <= 25; x++)
                    if (y < 32 || y > 47) gray[y * cols + x] = 50.0;
            Check(TrunkObservation.TryEdgeSupportedSegment(gray, cols, rows, center, out start, out length),
                  "两段可见的合成竖柱应得到候选");
            Check((start >= 10 && start + length <= 32) || (start >= 48 && start + length <= 70),
                  "不能跨遮挡缺口拼接成完整可见段");
        }

        static void UnsupportedPixelFormat()
        {
            var f = new Fixture(0.0, false);
            using (var indexed = new Bitmap(Width, Height, PixelFormat.Format8bppIndexed))
            {
                TrunkMeasure measure;
                Check(!TrunkObservation.MeasureEx(indexed, f.Tree, f.Ca, f.A, 0.0, 0.0, out measure),
                      "索引色位图不能按三字节 BGR 越界读取");
                Check(!TrunkObservation.MeasureEx(indexed, f.Tree, f.Ca, f.A, 0.0, 0.0, true, out measure),
                      "双边缘分支也必须拒绝索引色位图");
            }
        }

        static void EvidencePixelAndProjectionChecks()
        {
            Check(DualFrameImageEvidence.Fingerprint(null) == null, "空图不得生成哈希");
            using (var transparent = new Bitmap(4, 3, PixelFormat.Format32bppArgb))
                Check(DualFrameImageEvidence.Fingerprint(transparent) == null, "透明像素不能伪装成可复算图证");

            // 人工构造负 stride 位图，与 GetPixel 组成的规范位图比较逻辑行顺序。
            const int width = 4, height = 3, stride = width * 4;
            IntPtr storage = Marshal.AllocHGlobal(stride * height);
            try
            {
                byte[] bytes = new byte[stride * height];
                for (int y = 0; y < height; y++)
                    for (int x = 0; x < width; x++)
                    {
                        int i = y * stride + x * 4;
                        bytes[i] = (byte)(15 + y * 30); bytes[i + 1] = (byte)(20 + x * 20);
                        bytes[i + 2] = 100; bytes[i + 3] = 255;
                    }
                Marshal.Copy(bytes, 0, storage, bytes.Length);
                using (var negative = new Bitmap(width, height, -stride, PixelFormat.Format32bppArgb,
                                                  IntPtr.Add(storage, stride * (height - 1))))
                using (var normalized = new Bitmap(width, height, PixelFormat.Format32bppArgb))
                {
                    for (int y = 0; y < height; y++)
                        for (int x = 0; x < width; x++) normalized.SetPixel(x, y, negative.GetPixel(x, y));
                    EvidenceImageHash a = DualFrameImageEvidence.Fingerprint(negative);
                    EvidenceImageHash b = DualFrameImageEvidence.Fingerprint(normalized);
                    Check(a != null && b != null && a.Sha256 == b.Sha256,
                          "负 stride 必须按与规范位图一致的逻辑行顺序哈希");
                }
            }
            finally { Marshal.FreeHGlobal(storage); }

            var source = new EvidenceImageHash(100, 50, new string('a', 64));
            var observation = new TrunkMeasure { AzPix = 359.5, ElTop = 10, ElBot = -10, WidthDeg = 4 };
            DualFrameObservationEvidence seam = DualFrameObservationEvidence.Create("seam.jpg", observation, 0, 0, source);
            Check(seam != null && seam.X > 0.99, "全景横坐标必须按 360 度环绕");
            observation.AzPix = double.NaN;
            Check(DualFrameObservationEvidence.Create("bad.jpg", observation, 0, 0, source) == null,
                  "非有限方位不能生成图证");
            observation.AzPix = 1; observation.WidthDeg = double.PositiveInfinity;
            Check(DualFrameObservationEvidence.Create("bad.jpg", observation, 0, 0, source) == null,
                  "非有限宽度不能生成图证");
            observation.WidthDeg = 4; observation.ElTop = -10;
            Check(DualFrameObservationEvidence.Create("bad.jpg", observation, 0, 0, source) == null,
                  "无效的上下界不能生成图证");
            using (var image = new Bitmap(100, 50, PixelFormat.Format24bppRgb))
            using (Graphics g = Graphics.FromImage(image))
            {
                g.Clear(Color.Green);
                using (Bitmap marked = DualFrameImageEvidence.MarkObservation(image, seam))
                {
                    Check(marked.GetPixel(0, 25).R > 200 && marked.GetPixel(99, 25).R > 200,
                          "跨接缝的观测标记必须显示在两侧");
                }
            }
        }

        static void EvidenceProtocolBudget()
        {
            const string small = "data:image/png;base64,abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789++//==";
            Check(DualFrameImageEvidence.JsonImageUpperBound(small) >= JsonSerializer.Serialize(small).Length,
                  "图像上界不能低估 JSON 转义长度");
            Check(DualFrameImageEvidence.FitsJsonLineBudget(512, small, small, small, small),
                  "小的四张证据图应满足协议大小限制");
            Check(!DualFrameImageEvidence.FitsJsonLineBudget(-1, small, small, small, small),
                  "无效元数据长度必须拒绝");
            Check(!DualFrameImageEvidence.FitsJsonLineBudget(512, small, small, small, "not a PNG"),
                  "非法图像 data URL 必须拒绝");
            string heavy = "data:image/png;base64," + new string('+', 3 * 1024 * 1024);
            Check(!DualFrameImageEvidence.FitsJsonLineBudget(512, heavy, heavy, heavy, heavy),
                  "即使 base64 原始字符较少，转义后超过 64 MiB 也必须拒绝");
            string large = "data:image/png;base64," + new string('A', 17 * 1024 * 1024);
            Check(!DualFrameImageEvidence.FitsJsonLineBudget(512, large, large, large, large),
                  "超过 64 MiB 的 JSON 行必须拒绝");
        }

        static void CloseViewMidpoint()
        {
            var f = new Fixture(0.0, false, true);
            DualFrameResult result = f.Analyze(true, true, false, false, AxisX, AxisY,
                                               f.PrimaryBottom, f.PrimaryTop);
            Console.WriteLine("SYNTHETIC close-cropped status=" + result.Status + " reason=" + result.Reason);
            // 没有足够证据时允许明确回退，但绝不允许假成功。
            if (result.Status != DualFrameStatus.Success)
            {
                Check(result.Status == DualFrameStatus.Fallback, "近景不可验证时应明确回退");
                return;
            }
            double az = Azimuth(AxisX, AxisY, f.A);
            double topY = f.Project(az, Elevation(f.PrimaryTop, f.A, f.Ca.Dh))[1];
            double bottomY = f.Project(az, Elevation(f.PrimaryBottom, f.A, f.Ca.Dh))[1];
            double visibleTop = Math.Max(0, Math.Min(1, Math.Min(topY, bottomY)));
            double visibleBottom = Math.Max(0, Math.Min(1, Math.Max(topY, bottomY)));
            Check(topY < 0 || bottomY > 1, "该样例必须真实裁切 4:3 边缘");
            Check(visibleBottom - visibleTop > 0.2, "裁切后仍应有可辨认树干段");
            double measuredY = f.Project(result.AzNew, result.ElNew)[1];
            Near(measuredY, (visibleTop + visibleBottom) * 0.5, 0.04, "近距裁切后画面中点");
        }

        static void NeighborAmbiguity()
        {
            // 目标树心与树干轴心故意不同，邻树则仅有树心数据。
            var target = new UtmTree { Id = 1, X = 0.3, Y = 0, Z = 0, Height = 5 };
            var neighbor = new UtmTree { Id = 2, X = 1.0, Y = 0, Z = 0, Height = 5 };
            var forest = new UtmForest();
            forest.Trees.Add(target); forest.Trees.Add(neighbor);
            var axes = new Dictionary<int, double[]> { { 1, new double[] { 0, 0 } } };
            using (BackendSession session = SessionWithForest(forest, axes))
            {
                Check(!session.AxisConflictsNeighbor(target, 0.30, 0), "目标明显更近时不应误判歧义");
                Check(!session.AxisConflictsNeighbor(target, 0.3749, 0), "邻树距离差大于 0.25m 不应报歧义");
                Check(session.AxisConflictsNeighbor(target, 0.3750, 0), "邻树距离差等于 0.25m 应报歧义");
                Check(session.AxisConflictsNeighbor(target, 0.3751, 0), "邻树距离差小于 0.25m 应报歧义");
                Check(session.AxisConflictsNeighbor(target, 0.40, 0), "近 0.25m 差距应视为歧义");
                Check(session.AxisConflictsNeighbor(target, 0.50, 0), "两棵树等近应视为歧义");
                Check(session.AxisConflictsNeighbor(target, 0.75, 0), "更近邻树应视为歧义");
                Check(session.AxisConflictsNeighbor(target, double.NaN, 0), "无效位置应保守回退");
            }
        }

        static Func<double, double, double[]> PhotoProjector(double pan, double tilt, double vf)
        {
            double hf = Proj.Hfov(vf, 4.0 / 3.0);
            return delegate(double az, double el) {
                double a = Geo.Rad(az - pan), e = Geo.Rad(el), e0 = Geo.Rad(tilt);
                double forward = Math.Cos(e) * Math.Cos(a) * Math.Cos(e0) + Math.Sin(e) * Math.Sin(e0);
                if (Proj.NaturalD + forward <= 1e-9) return null;
                double x, y;
                Proj.PixelFromWorld(az, el, pan, tilt,
                                    Proj.HalfScale(hf / 2.0), Proj.HalfScale(vf / 2.0),
                                    0.0, out x, out y);
                return new double[] { x, y };
            };
        }

        static double[] IndependentVisibleY(Func<double, double, double[]> project, double[] camera,
                                             double bottom, double top)
        {
            // 用 10 万个独立高度采样求画面可见段端点，避免复用被测算法的 128 点+二分逻辑。
            const int steps = 100000;
            double[] first = null, last = null;
            int runs = 0; bool inRun = false;
            for (int i = 0; i <= steps; i++)
            {
                double z = bottom + (top - bottom) * i / steps;
                double[] p = project(0.0, Elevation(z, camera, 0.8));
                bool visible = p != null && p.Length >= 2 && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1;
                if (visible && !inRun) { runs++; inRun = true; if (first == null) first = p; }
                if (!visible) inRun = false;
                if (visible) last = p;
            }
            Check(runs == 1 && first != null && last != null, "独立真值场景应存在唯一可见段");
            return new double[] { first[1], last[1] };
        }

        static void ProjectedMidpointCase(double pan, double tilt, double vf, string label)
        {
            double[] camera = { 0, -0.8, 1.5, 0, 0, 0 };
            var a = new TrunkMeasure { ZBot = 0, ZTop = 3.5 };
            var b = new TrunkMeasure { ZBot = 0, ZTop = 3.5 };
            Func<double, double, double[]> projector = PhotoProjector(pan, tilt, vf);
            double[] expected = IndependentVisibleY(projector, camera, a.ZBot, a.ZTop);
            double low, high, middle;
            Check(DualFrameGeometry.TryImageVisibleMidpoint(a, b, 5.0, 0.0, camera, 0.0, 0.0,
                                                            projector, out low, out high, out middle),
                  label + " 应得到可验证画面中点");
            double actualY = projector(0.0, Elevation(middle, camera, 0.8))[1];
            Near(actualY, (expected[0] + expected[1]) / 2.0, 0.0002, label + " 可见段像素中点");
            Check(middle >= low && middle <= high, label + " 中点必须在 B 的可见段中");
            if (pan == 0.0 && tilt == 0.0)
            {
                double worldY = projector(0.0, Elevation((a.ZBot + a.ZTop) * 0.5, camera, 0.8))[1];
                Check(Math.Abs(worldY - actualY) > 0.05, "该近距例必须能区别世界高度中点和画面中点");
            }
        }

        static void GeometryVisibleMidpoint()
        {
            double previous = Proj.NaturalD;
            try
            {
                foreach (double projection in new double[] { Proj.LowDistortionD, Proj.LegacyD })
                {
                    Proj.NaturalD = projection;
                    Console.WriteLine("SYNTHETIC geometry projection=" + projection);
                    ProjectedMidpointCase(0, 0, 120, "上下裁切");
                    ProjectedMidpointCase(-60, -45, 60, "右侧裁切");
                    ProjectedMidpointCase(60, -45, 60, "左侧裁切");
                    ProjectedMidpointCase(-60, 45, 60, "右侧及上侧裁切");
                }
                double[] camera = { 0, -0.8, 1.5, 0, 0, 0 };
                var a = new TrunkMeasure { ZBot = 0, ZTop = 3.5 };
                var b = new TrunkMeasure { ZBot = 0, ZTop = 0.7 };
                double low, high, middle;
                Func<double, double, double[]> photo = PhotoProjector(0, 0, 120);
                Check(!DualFrameGeometry.TryImageVisibleMidpoint(a, b, 5, 0, camera, 0, 0,
                                                                 photo, out low, out high, out middle),
                      "B 未覆盖画面中点必须回退");
                b.ZTop = 3.5;
                Check(!DualFrameGeometry.TryImageVisibleMidpoint(a, b, 5, 0, camera, 0, 0,
                                                                 null, out low, out high, out middle),
                      "缺投影委托必须回退");
                Check(!DualFrameGeometry.TryImageVisibleMidpoint(a, b, 5, 0, camera, 0, 0,
                                                                 delegate { return null; }, out low, out high, out middle),
                      "投影无效必须回退");
                Check(!DualFrameGeometry.TryImageVisibleMidpoint(a, b, 5, 0, camera, 0, 0,
                    delegate(double az, double el) { return new double[] { double.NaN, 0.5 }; },
                    out low, out high, out middle), "非有限投影必须回退");
                Check(!DualFrameGeometry.TryImageVisibleMidpoint(a, b, 5, 0, camera, 0, 0,
                    delegate(double az, double el) { return new double[] { -0.1, 0.5 - el / 180.0 }; },
                    out low, out high, out middle), "树干完全不在横向画幅中必须回退");
                Check(!DualFrameGeometry.TryImageVisibleMidpoint(a, b, 5, 0, camera, 0, 0,
                    delegate(double az, double el) {
                        return new double[] { Math.Abs(el) > 10 ? 0.5 : 1.1, 0.5 - el / 180.0 };
                    }, out low, out high, out middle), "画面可见段不连续必须回退");
                double[] coincident = { 0, 0, 1.5, 0, 0, 0 };
                Check(!DualFrameGeometry.TryImageVisibleMidpoint(a, b, 5, 0, coincident, 0, 0,
                                                                 photo, out low, out high, out middle),
                      "相机与树干水平重合时不能计算方位");
            }
            finally { Proj.NaturalD = previous; }
        }

        static TrunkMeasure SignatureProfile(double[] pose, double distance,
                                              Func<double, double> luminanceAtWorldZ)
        {
            const int rows = 720;
            double top = Elevation(2.0, pose, distance), bottom = Elevation(0.3, pose, distance);
            var values = new float[rows];
            for (int i = 0; i < rows; i++)
            {
                double elevation = top - (top - bottom) * i / (rows - 1.0);
                double worldZ = pose[2] + distance * Math.Tan(Geo.Rad(elevation));
                values[i] = (float)luminanceAtWorldZ(worldZ);
            }
            return new TrunkMeasure {
                ElTop = top, ElBot = bottom, GrayProfile = values,
                WidthDeg = Geo.Deg(Math.Atan(0.20 / distance))
            };
        }

        static void AppearanceConsistency()
        {
            double[] a = { 0, 0, 1.5, 0, 0, 0 }, b = { 3, 0, 1.7, 0, 0, 0 };
            const double distanceA = 5.0, distanceB = 8.0;
            Func<double, double> bark = delegate(double z) {
                return 90 + 14 * Math.Sin(z * 19) + 8 * Math.Cos(z * 31);
            };
            TrunkMeasure original = SignatureProfile(a, distanceA, bark);
            TrunkMeasure brighter = SignatureProfile(b, distanceB, delegate(double z) {
                return 1.25 * bark(z) + 13.0;
            });
            double correlation; string reason;
            Check(TrunkAppearance.Agree(original, brighter, a, b, distanceA, distanceB, 0,
                                        0.3, 2.0, out correlation, out reason),
                  "同一世界纹理乘法曝光+亮度偏移应匹配: " + reason);
            Check(correlation > 0.95, "同一世界纹理的相关度应高");

            TrunkMeasure slopeA = SignatureProfile(a, distanceA, delegate(double z) { return 60 + 20 * z; });
            TrunkMeasure slopeB = SignatureProfile(b, distanceB, delegate(double z) { return 40 + 35 * z; });
            Check(!TrunkAppearance.Agree(slopeA, slopeB, a, b, distanceA, distanceB, 0,
                                         0.3, 2.0, out correlation, out reason),
                  "两根杆共同的光照坡度不能冒充树皮对应");
            TrunkMeasure stepA = SignatureProfile(a, distanceA, delegate(double z) { return z < 1.15 ? 50 : 100; });
            TrunkMeasure stepB = SignatureProfile(b, distanceB, delegate(double z) { return z < 1.15 ? 70 : 145; });
            Check(!TrunkAppearance.Agree(stepA, stepB, a, b, distanceA, distanceB, 0,
                                         0.3, 2.0, out correlation, out reason),
                  "单一颜色阶跃不能冒充足够的树皮纹理");
            TrunkMeasure other = SignatureProfile(b, distanceB, delegate(double z) {
                return 95 + 14 * Math.Sin(z * 43) + 8 * Math.Cos(z * 57);
            });
            Check(!TrunkAppearance.Agree(original, other, a, b, distanceA, distanceB, 0,
                                         0.3, 2.0, out correlation, out reason),
                  "不同的世界高度纹理不应匹配");
        }

        static void OperatorPriorRisk()
        {
            // 这些测试只验证经验扇区几何；扇区外不等于检测到无人。
            var frame = new FrameCandidate { A0 = 350.0 };
            var inside = new TrunkMeasure { AzPix = 80.0, WidthDeg = 4.0 };
            Check(BackendSession.ObservationAtOperatorRisk(frame, inside), "跨 0° 环绕仍应命中经验区");
            var leftSafe = new TrunkMeasure { AzPix = Geo.Wrap360(frame.A0 + 38.9), WidthDeg = 0.0 };
            var leftOverlap = new TrunkMeasure { AzPix = Geo.Wrap360(frame.A0 + 39.1), WidthDeg = 0.0 };
            var rightOverlap = new TrunkMeasure { AzPix = Geo.Wrap360(frame.A0 + 135.9), WidthDeg = 0.0 };
            var rightSafe = new TrunkMeasure { AzPix = Geo.Wrap360(frame.A0 + 136.1), WidthDeg = 0.0 };
            Check(!BackendSession.ObservationAtOperatorRisk(frame, leftSafe), "左边界余量外不应误判重叠");
            Check(BackendSession.ObservationAtOperatorRisk(frame, leftOverlap), "左边界内加余量应命中");
            Check(BackendSession.ObservationAtOperatorRisk(frame, rightOverlap), "右边界内加余量应命中");
            Check(!BackendSession.ObservationAtOperatorRisk(frame, rightSafe), "右边界余量外不应误判重叠");
            Check(BackendSession.ObservationAtOperatorRisk(null, inside), "缺帧参数应保守拒绝");
            Check(BackendSession.ObservationAtOperatorRisk(new FrameCandidate { A0 = double.NaN }, inside),
                  "无效参考方位应保守拒绝");
            Check(BackendSession.ObservationAtOperatorRisk(frame, new TrunkMeasure { AzPix = double.NaN }),
                  "无效观测方位应保守拒绝");
            Check(BackendSession.ObservationAtOperatorRisk(frame, new TrunkMeasure { AzPix = 80, WidthDeg = -1 }),
                  "负树干宽度应保守拒绝");
            Check(BackendSession.ObservationAtOperatorRisk(frame, new TrunkMeasure { AzPix = 80, WidthDeg = double.PositiveInfinity }),
                  "无穷树干宽度应保守拒绝");

            var unsafeA = new Fixture(0, false);
            unsafeA.Ca.A0 = unsafeA.Ca.AzT - 90.0;
            DualFrameResult resultA = unsafeA.Analyze(true, true, false, false, AxisX, AxisY, 0.3, 2.0);
            Check(resultA.Status == DualFrameStatus.Fallback &&
                  resultA.Reason == FallbackReason.PrimaryObservationOperatorRisk,
                  "主帧观测命中经验区必须回退");
            var unsafeB = new Fixture(0, false);
            unsafeB.Cb.A0 = unsafeB.Cb.AzT - 90.0;
            DualFrameResult resultB = unsafeB.Analyze(true, true, false, false, AxisX, AxisY, 0.3, 2.0);
            Check(resultB.Status == DualFrameStatus.Fallback &&
                  resultB.Reason == FallbackReason.SecondaryObservationOperatorRisk,
                  "辅助帧观测命中经验区必须回退");
        }

        static void BackendPhotoProjection()
        {
            var tree = new UtmTree { Id = 1, X = 0.22, Y = -0.16, Z = 0, Height = 5 };
            double[] camera = { -6, -6, 1.4, 0, 0, 0 };
            double dh = Geo.Dist2D(tree.X - camera[0], tree.Y - camera[1]);
            double baseEl = Elevation(tree.Z, camera, dh), topEl = Elevation(tree.Z + tree.Height, camera, dh);
            double bearing = Azimuth(tree.X, tree.Y, camera) + 25.0, aimEl = 18.0;
            double previous = Proj.NaturalD;
            using (var session = new BackendSession())
            {
                FieldInfo levelField = typeof(BackendSession).GetField("_levelView",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                Check(levelField != null, "应能设置隔离的水平取景模式");
                try
                {
                    foreach (double projection in new double[] { Proj.LowDistortionD, Proj.LegacyD })
                    foreach (bool level in new bool[] { true, false })
                    {
                        Proj.NaturalD = projection;
                        levelField.SetValue(session, level);
                        Func<double, double, double[]> actual = session.CreatePrimaryPhotoProjector(tree, camera, bearing, aimEl);
                        Check(actual != null, "有效手动视图必须创建投影");
                        double viewEl = level ? 0 : aimEl;
                        double span = level ? 2 * Math.Max(-baseEl, topEl) + 8
                                            : 2 * Math.Max(aimEl - baseEl, topEl - aimEl) + 8;
                        double vf = Math.Max(40, Math.Min(120, span));
                        double hf = Proj.Hfov(vf, 4.0 / 3.0);
                        double th = Proj.HalfScale(hf / 2), tv = Proj.HalfScale(vf / 2), shift = 0;
                        if (level)
                        {
                            double x, yTop, yBase;
                            Proj.PixelFromWorld(bearing, topEl, bearing, viewEl, th, tv, 0, out x, out yTop);
                            Proj.PixelFromWorld(bearing, baseEl, bearing, viewEl, th, tv, 0, out x, out yBase);
                            if (yTop < 0.06)
                                shift = Math.Min(2 * (0.06 - yTop), Math.Max(0, 2 * (0.98 - yBase)));
                        }
                        foreach (double azOffset in new double[] { -20.0, 0.0, 25.0, 85.0 })
                        {
                            double x, y;
                            Proj.PixelFromWorld(bearing + azOffset, 10.0, bearing, viewEl, th, tv, shift, out x, out y);
                            double[] point = actual(bearing + azOffset, 10.0);
                            Check(point != null, "有效方向应能投影");
                            Near(point[0], x, 1e-10, "手动视图投影 X");
                            Near(point[1], y, 1e-10, "手动视图投影 Y");
                        }
                        double[] outside = actual(bearing + 85.0, 10.0);
                        Check(outside[0] > 1.0, "水平画外坐标应保留，不应错误钳回图片内");
                        Check(actual(bearing + 180.0, -viewEl) == null, "投影奇异方向应返回无效而非画面中心");
                        Check(actual(double.NaN, 0) == null && actual(bearing, double.PositiveInfinity) == null,
                              "非有限角度应返回无效");
                    }
                    double[] badPose = { -6, -6, 1.4, double.NaN, 0, 0 };
                    Check(session.CreatePrimaryPhotoProjector(tree, badPose, bearing, aimEl) == null,
                          "非有限位姿不能构建投影");
                }
                finally { Proj.NaturalD = previous; }
            }
        }

        static void CandidateAxesAndDistanceLimits()
        {
            var tree = new UtmTree { Id = 1, X = 0, Y = 5, Z = 0, Height = 4 };
            var forest = new UtmForest(); forest.Trees.Add(tree);
            var axes = new Dictionary<int, double[]> { { 1, new double[] { 0, 5 } } };
            double[] camera = { 0, 0, 1.5, 0, 0, -10 };
            using (BackendSession session = SessionWithForest(forest, axes))
            {
                bool firstOk, displacedOk;
                FrameCandidate centered = session.MakeDualFrameCandidate(tree, camera, 0, 0, out firstOk);
                Check(centered != null, "合法的辅助帧应构造候选");
                tree.X = 3.0; // 保持点云轴心 (0,5)，仅移动树冠中心。
                FrameCandidate displaced = session.MakeDualFrameCandidate(tree, camera, 0, 0, out displacedOk);
                Check(displaced != null, "偏移树心仍应构造候选");
                Near(centered.AzT, displaced.AzT, 1e-10, "双帧观测方位必须使用树干轴心");
                Near(centered.Dh, displaced.Dh, 1e-10, "双帧观测距离必须使用树干轴心");
                Check(displaced.PriorOverlap > centered.PriorOverlap + 0.1,
                      "4:3 画面避让必须跟随树心构图，而不能沿用树干轴心方位");

                bool hard;
                axes[1] = new double[] { 0, 2.499 };
                Check(session.MakeDualFrameCandidate(tree, camera, 1, 0, out hard) == null,
                      "B 距离低于窗口不得进入辅助候选");
                Check(session.MakeDualFrameCandidate(tree, camera, 1, 0, out hard, true) != null && !hard,
                      "手动/最近的近主帧保留，不能因 B 的距离窗口静默换帧");
                axes[1] = new double[] { 0, 2.5 };
                Check(session.MakeDualFrameCandidate(tree, camera, 1, 0, out hard) != null,
                      "B 距离下界应包含 2.5m");
                axes[1] = new double[] { 0, 30.0 };
                Check(session.MakeDualFrameCandidate(tree, camera, 1, 0, out hard) != null,
                      "B 距离上界应包含 30m");
                axes[1] = new double[] { 0, 30.001 };
                Check(session.MakeDualFrameCandidate(tree, camera, 1, 0, out hard) == null,
                      "B 距离超过窗口不得进入辅助候选");
                Check(session.MakeDualFrameCandidate(tree, camera, 1, 0, out hard, true) != null && !hard,
                      "远距手动主帧保留，不应隐式替换");
                axes[1] = new double[] { 0, 0.049 };
                Check(session.MakeDualFrameCandidate(tree, camera, 1, 0, out hard, true) == null,
                      "极近重合主帧不得伪造方向");
                axes[1] = new double[] { 0, 5 };
                double[] invalid = { 0, 0, 1.5, 0, double.NaN, 0 };
                Check(session.MakeDualFrameCandidate(tree, invalid, 1, 0, out hard) == null,
                      "缺少完整有限姿态不能构造候选");
            }
        }

        static void SubpixelTrunkCenter()
        {
            var fixture = new Fixture(0, false);
            const double fractionalColumn = 720.49;
            fixture.Ca.A0 = fixture.Ca.AzT - fractionalColumn * 360.0 / Width;
            using (Bitmap image = Panorama(fixture.A, fixture.Ca.A0, 0, AxisX, AxisY,
                                           0.3, 2.0, true, false, 0, 1701))
            {
                List<TrunkMeasure> candidates = TrunkAppearance.Candidates(
                    image, fixture.Tree, fixture.Ca, fixture.A, 0, 0);
                Check(candidates.Count > 0, "亚像素方位应可检测到合成树干");
                // 此合成柱的边界在整数像素网格上对称，二次预测偏移不应再叠加到检测中心。
                double expectedColumn = Math.Round(fractionalColumn);
                double expectedAz = Geo.Wrap360(fixture.Ca.A0 + expectedColumn * 360.0 / Width);
                double nearestError = double.PositiveInfinity;
                foreach (TrunkMeasure m in candidates)
                {
                    Console.WriteLine("SYNTHETIC subpixel az=" + m.AzPix + " expected=" + expectedAz);
                    nearestError = Math.Min(nearestError, Math.Abs(Geo.Wrap180(m.AzPix - expectedAz)));
                }
                Check(nearestError < 0.08, "不应把亚像素预测误差二次加到像素中心: " + nearestError);
            }
        }

        internal static int Run(string[] args)
        {
            try
            {
                ExperimentConfiguration(args);
                IdealPair(false, 0.0);
                IdealPair(true, 0.0);
                IdealPair(false, 6.0);
                SecondaryPartialOcclusion();
                LongVisibleTrunk();
                EdgeSegmentNegativeCases();
                UnsupportedPixelFormat();
                EvidencePixelAndProjectionChecks();
                EvidenceProtocolBudget();
                NegativeCases();
                EvidenceFailureDoesNotChangeResult();
                CloseViewMidpoint();
                NeighborAmbiguity();
                GeometryVisibleMidpoint();
                AppearanceConsistency();
                OperatorPriorRisk();
                BackendPhotoProjection();
                CandidateAxesAndDistanceLimits();
                SubpixelTrunkCenter();
                Console.WriteLine("PASS " + checks + " physical dual-frame checks");
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
