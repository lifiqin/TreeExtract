using System;

namespace TreeExtractor
{
    /// <summary>
    /// 双帧纯几何层：水平射线交会、可见段和可信度诊断。
    /// 不读图、不访问 UI，只依赖 Geo 与 DualFrameConfig。
    /// </summary>
    internal static class DualFrameGeometry
    {
        /// <summary>取两帧共同可见高度段，并约束在树底和树顶之间。</summary>
        public static bool TryCommonVisibleHeight(TrunkMeasure a, TrunkMeasure b, double height,
                                                   out double low, out double high, out double middle)
        {
            low = high = middle = 0.0;
            if (!Finite(height) || height <= 0.0 || !Finite(a.ZBot) || !Finite(a.ZTop)
                || !Finite(b.ZBot) || !Finite(b.ZTop)) return false;
            low = Math.Max(0.0, Math.Max(a.ZBot, b.ZBot));
            high = Math.Min(height, Math.Min(a.ZTop, b.ZTop));
            if (high - low < DualFrameConfig.CommonVisibleMinM) return false;
            middle = (low + high) * 0.5;
            return true;
        }

        /// <summary>以主帧可见段为准取中点，并要求辅助帧也覆盖该点。</summary>
        public static bool TryPrimaryVisibleMidpoint(TrunkMeasure a, TrunkMeasure b, double height,
                                                      out double low, out double high, out double middle)
        {
            double unused;
            if (!TryCommonVisibleHeight(a, b, height, out low, out high, out unused))
            {
                middle = 0.0;
                return false;
            }
            double primaryLow = Math.Max(0.0, a.ZBot);
            double primaryHigh = Math.Min(height, a.ZTop);
            middle = (primaryLow + primaryHigh) * 0.5;
            return middle >= low && middle <= high;
        }

        /// <summary>
        /// 把主帧观测段投到实际 4:3 照片，裁去画外部分并取屏幕纵向中点；
        /// 中点必须同时处于副帧观测段。无投影或可见区间不唯一时不猜测。
        /// </summary>
        public static bool TryImageVisibleMidpoint(TrunkMeasure a, TrunkMeasure b, double height,
                                                   double baseZ, double[] camera, double axisX, double axisY,
                                                   Func<double, double, double[]> project,
                                                   out double low, out double high, out double middle)
        {
            low = high = middle = 0.0;
            if (project == null || camera == null || camera.Length < 3 || !Finite(height) ||
                !Finite(baseZ) || !Finite(axisX) || !Finite(axisY) || !Finite(camera[0]) ||
                !Finite(camera[1]) || !Finite(camera[2]) || !Finite(a.ZBot) || !Finite(a.ZTop) ||
                !Finite(b.ZBot) || !Finite(b.ZTop) || height <= 0.0) return false;
            double az = Geo.Wrap360(Geo.Deg(Math.Atan2(axisX - camera[0], axisY - camera[1])));
            double distance = Geo.Dist2D(axisX - camera[0], axisY - camera[1]);
            if (!Finite(distance) || distance < 1e-6) return false;
            double startZ = Math.Max(0.0, a.ZBot), endZ = Math.Min(height, a.ZTop);
            if (endZ - startZ < DualFrameConfig.CommonVisibleMinM) return false;
            int start = -1, end = -1, runs = 0;
            bool inRun = false;
            for (int i = 0; i <= DualFrameConfig.ViewClipSamples; i++)
            {
                double z = startZ + (endZ - startZ) * i / DualFrameConfig.ViewClipSamples;
                double x, y;
                bool visible = ProjectHeight(project, az, distance, camera[2], baseZ, z, out x, out y) &&
                    x >= 0.0 && x <= 1.0 && y >= 0.0 && y <= 1.0;
                if (visible && !inRun) { runs++; if (runs == 1) start = i; inRun = true; }
                if (!visible && inRun) { if (runs == 1) end = i - 1; inRun = false; }
            }
            if (inRun && runs == 1) end = DualFrameConfig.ViewClipSamples;
            if (runs != 1 || start < 0 || end <= start) return false;
            double step = (endZ - startZ) / DualFrameConfig.ViewClipSamples;
            double visibleLow = startZ + start * step;
            double visibleHigh = startZ + end * step;
            if (start > 0) visibleLow = RefineViewEdge(project, az, distance, camera[2], baseZ,
                                                       visibleLow - step, visibleLow, true);
            if (end < DualFrameConfig.ViewClipSamples)
                visibleHigh = RefineViewEdge(project, az, distance, camera[2], baseZ,
                                             visibleHigh, visibleHigh + step, false);
            double xLow, yLow, xHigh, yHigh;
            if (!ProjectHeight(project, az, distance, camera[2], baseZ, visibleLow, out xLow, out yLow) ||
                !ProjectHeight(project, az, distance, camera[2], baseZ, visibleHigh, out xHigh, out yHigh) ||
                !Finite(yLow) || !Finite(yHigh) || yLow <= yHigh) return false;
            // 视图 Y 随世界高度单调下降；若透视范围出现折返，则拒绝该观测。
            double previousY = yLow;
            for (int i = 1; i <= 16; i++)
            {
                double x, y;
                double z = visibleLow + (visibleHigh - visibleLow) * i / 16.0;
                if (!ProjectHeight(project, az, distance, camera[2], baseZ, z, out x, out y) ||
                    y > previousY + 1e-7) return false;
                previousY = y;
            }
            double targetY = (yLow + yHigh) * 0.5;
            double l = visibleLow, r = visibleHigh;
            for (int i = 0; i < DualFrameConfig.ViewClipBisections; i++)
            {
                double z = (l + r) * 0.5, x, y;
                if (!ProjectHeight(project, az, distance, camera[2], baseZ, z, out x, out y)) return false;
                if (y > targetY) l = z; else r = z;
            }
            middle = (l + r) * 0.5;
            low = Math.Max(visibleLow, b.ZBot);
            high = Math.Min(visibleHigh, b.ZTop);
            return high - low >= DualFrameConfig.CommonVisibleMinM && middle >= low && middle <= high;
        }

        static bool ProjectHeight(Func<double, double, double[]> project, double az, double distance,
                                  double cameraZ, double baseZ, double z, out double x, out double y)
        {
            x = y = double.NaN;
            double el = Geo.Deg(Math.Atan2(baseZ + z - cameraZ, distance));
            double[] result = project(az, el);
            if (result == null || result.Length < 2 || !Finite(result[0]) || !Finite(result[1])) return false;
            x = result[0]; y = result[1];
            return true;
        }

        static double RefineViewEdge(Func<double, double, double[]> project, double az, double distance,
                                     double cameraZ, double baseZ, double low, double high, bool upperIsInside)
        {
            for (int i = 0; i < DualFrameConfig.ViewClipBisections; i++)
            {
                double mid = (low + high) * 0.5, x, y;
                bool inside = ProjectHeight(project, az, distance, cameraZ, baseZ, mid, out x, out y) &&
                              x >= 0.0 && x <= 1.0 && y >= 0.0 && y <= 1.0;
                if (inside == upperIsInside) high = mid; else low = mid;
            }
            return upperIsInside ? high : low;
        }

        /// <summary>仅按两帧水平观测方位求前向交点；不假定两帧可见段中点等高。</summary>
        public static bool TryIntersectHorizontal(double[] a, double azA, double[] b, double azB,
                                                  out double x, out double y)
        {
            x = y = 0.0;
            if (a == null || b == null || a.Length < 2 || b.Length < 2 ||
                !Finite(a[0]) || !Finite(a[1]) || !Finite(b[0]) || !Finite(b[1]) ||
                !Finite(azA) || !Finite(azB)) return false;
            double ax = Math.Sin(Geo.Rad(azA)), ay = Math.Cos(Geo.Rad(azA));
            double bx = Math.Sin(Geo.Rad(azB)), by = Math.Cos(Geo.Rad(azB));
            double cross = ax * by - ay * bx;
            if (Math.Abs(cross) < Math.Sin(Geo.Rad(DualFrameConfig.BaselineAngleMinDeg))) return false;
            double dx = b[0] - a[0], dy = b[1] - a[1];
            double alongA = (dx * by - dy * bx) / cross;
            double alongB = (dx * ay - dy * ax) / cross;
            if (alongA <= 0.0 || alongB <= 0.0) return false;
            x = a[0] + alongA * ax;
            y = a[1] + alongA * ay;
            return Finite(x) && Finite(y);
        }

        static bool Finite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        /// <summary>共同段比例与轴心偏离的启发式一致性，不是经过标注校准的概率。</summary>
        public static double GeometricAgreement(TrunkMeasure a, TrunkMeasure b, double low, double high,
                                                 double axisError, double axisLimit)
        {
            double shorter = Math.Min(a.ZTop - a.ZBot, b.ZTop - b.ZBot);
            if (!Finite(shorter) || !Finite(axisError) || !Finite(axisLimit) ||
                shorter <= 0.0 || axisError < 0.0 || axisLimit <= 0.0) return 0.0;
            double overlapRatio = Geo.Clamp((high - low) / shorter, 0.0, 1.0);
            return overlapRatio * Math.Exp(-axisError / axisLimit);
        }

        /// <summary>
        /// 诊断专用：两射线最近点闭式解。R3 起 Prepare 不再用它判失败，
        /// 残差只写日志/CSV。实现与 R2 完全一致（零改动）。
        /// </summary>
        public static bool Intersect(Ray3 a, Ray3 b, out Vec3 pMid, out double residualM)
        {
            pMid = new Vec3();
            residualM = double.NaN;

            double l1 = Math.Sqrt(Dot(a.D, a.D));
            double l2 = Math.Sqrt(Dot(b.D, b.D));
            if (l1 < 1e-9 || l2 < 1e-9) return false;
            if (double.IsNaN(l1) || double.IsNaN(l2)) return false;
            Vec3 d1 = Scale(a.D, 1.0 / l1);
            Vec3 d2 = Scale(b.D, 1.0 / l2);

            double bd = Dot(d1, d2);
            double den = 1.0 - bd * bd;
            if (den < 1e-6) return false;   // 近似平行：交会退化

            Vec3 w = Sub(a.O, b.O);
            double wd1 = Dot(w, d1);
            double wd2 = Dot(w, d2);
            // 最小化 |O1+s1·d1 - O2-s2·d2|²：
            //   s1 = (bd·wd2 - wd1)/(1-bd²)，s2 = wd2 + s1·bd
            double s1 = (bd * wd2 - wd1) / den;
            double s2 = wd2 + s1 * bd;
            if (s1 <= 0.0 || s2 <= 0.0) return false;   // 交点必须落在两台相机前方

            Vec3 pA = Add(a.O, Scale(d1, s1));
            Vec3 pB = Add(b.O, Scale(d2, s2));
            pMid = Scale(Add(pA, pB), 0.5);
            Vec3 dv = Sub(pA, pB);
            residualM = Math.Sqrt(Dot(dv, dv));
            if (double.IsNaN(residualM) || double.IsInfinity(residualM)) return false;
            return true;
        }

        // ===== R3 新增：理论基准 / 偏差 / 一致性 / 融合 =====

        /// <summary>
        /// 该帧「理论树干锚点」仰角（度）。dh 用 c.Dh，与 azTheory=c.AzT 同一柱。
        /// 与 MakeDualFrameCandidate 的 elA/elB/elT 同口径（Atan2 仅为数值稳健）。
        /// </summary>
        public static double TheoryElevation(UtmTree t, double[] mp, double dh, double hMark)
        {
            return Geo.Deg(Math.Atan2((t.Z + hMark) - mp[2],
                                      Math.Max(DualFrameConfig.TheoryDhFloorM, dh)));
        }

        /// <summary>单帧偏差：dAz 用 Wrap180 处理跨 0°；dEl 为直接差。</summary>
        public static void Deviations(TrunkMeasure m, double azTheory, double elTheory,
                                      out double dAz, out double dEl)
        {
            dAz = Geo.Wrap180(m.AzPix - Geo.Wrap360(azTheory));
            dEl = m.ElPix - elTheory;
        }

        /// <summary>
        /// 一致性：两帧同向姿态系统误差 ε 在 Wrap180(dAzA−dAzB) 中相消；
        /// 作为共同项保留在融合偏差里是必要的（与渲染角度空间自洽）。
        /// </summary>
        public static double Agreement(double dAzA, double dElA, double dAzB, double dElB)
        {
            double eAz = Math.Abs(Geo.Wrap180(dAzA - dAzB)) / DualFrameConfig.AgreeSigmaAzDeg;
            double eEl = Math.Abs(dElA - dElB) / DualFrameConfig.AgreeSigmaElDeg;
            return Math.Exp(-eAz) * Math.Exp(-eEl);
        }

        /// <summary>A 帧融合权重：由两帧 quality × 峰对比度加权并钳到 [0.2,0.8]。</summary>
        public static double FusionWeight(TrunkMeasure mA, TrunkMeasure mB)
        {
            double wA = Math.Max(DualFrameConfig.WeightFloor, mA.Quality * mA.PeakContrast);
            double wB = Math.Max(DualFrameConfig.WeightFloor, mB.Quality * mB.PeakContrast);
            return Geo.Clamp(wA / (wA + wB),
                             DualFrameConfig.FuseWeightAMin, DualFrameConfig.FuseWeightAMax);
        }

        /// <summary>
        /// 历史角偏差融合公式，保留用于旧数据对照；当前定位不调用。
        /// </summary>
        public static void FuseRelative(double azTheoryA, double elTheoryA,
                                        double dAzA, double dElA,
                                        double dAzB, double dElB, double w,
                                        out double azNew, out double elNew, out bool clamped)
        {
            double dAzF = w * dAzA + (1.0 - w) * dAzB;
            double dElF = w * dElA + (1.0 - w) * dElB;
            double cAz = Geo.Clamp(dAzF, -DualFrameConfig.LimitAzDeg, DualFrameConfig.LimitAzDeg);
            double cEl = Geo.Clamp(dElF, -DualFrameConfig.LimitElDeg, DualFrameConfig.LimitElDeg);
            clamped = (Math.Abs(cAz - dAzF) > DualFrameConfig.CompareEps
                    || Math.Abs(cEl - dElF) > DualFrameConfig.CompareEps);
            azNew = Geo.Wrap360(azTheoryA + cAz);
            elNew = Geo.Clamp(elTheoryA + cEl,
                              -DualFrameConfig.ElOutputClampDeg, DualFrameConfig.ElOutputClampDeg);
        }

        /// <summary>
        /// R3 置信度：0.40·agree + 0.25·min(qA,qB) + 0.20·fBase + 0.15·poseIntegrity。
        /// fBase 分母 (BaselineSatDeg − BaselineAngleMinDeg) = 35。
        /// </summary>
        public static double Confidence(double agree, double qA, double qB,
                                        double baselineDeg, double poseIntegrity)
        {
            double span = Math.Max(DualFrameConfig.WeightFloor,
                DualFrameConfig.BaselineSatDeg - DualFrameConfig.BaselineAngleMinDeg);
            double fBase = Geo.Clamp((baselineDeg - DualFrameConfig.BaselineAngleMinDeg) / span,
                                     0.0, 1.0);
            double[] w = DualFrameConfig.ConfW;
            return Geo.Clamp(w[0] * Geo.Clamp(agree, 0.0, 1.0)
                           + w[1] * Geo.Clamp(Math.Min(qA, qB), 0.0, 1.0)
                           + w[2] * fBase
                           + w[3] * Geo.Clamp(poseIntegrity, 0.0, 1.0), 0.0, 1.0);
        }

        /// <summary>
        /// DEF-05：按位姿来源判定完整性，取 A/B 两帧较小值。实现与 R2 一致。
        /// </summary>
        public static double PoseIntegrityOf(double[] mpA, double[] mpB)
        {
            return Math.Min(PoseOf(mpA), PoseOf(mpB));
        }

        static double PoseOf(double[] mp)
        {
            if (mp == null || mp.Length < DualFrameConfig.PoseDofCount) return 0.0;
            bool imuLike = Math.Abs(mp[3]) < DualFrameConfig.PoseImuEpsilon
                        && Math.Abs(mp[4]) < DualFrameConfig.PoseImuEpsilon;
            return imuLike ? DualFrameConfig.PoseIntegrityImu : DualFrameConfig.PoseIntegrityFull;
        }

        /// <summary>旧限幅函数保留但 Prepare 不再调用（融合内部已限幅）。</summary>
        public static void Limit(double azOld, double elOld, ref double azNew, ref double elNew,
                                 out bool clamped)
        {
            clamped = false;
            double dAz = Geo.Wrap180(azNew - azOld);
            double dEl = elNew - elOld;
            double cAz = Geo.Clamp(dAz, -DualFrameConfig.LimitAzDeg, DualFrameConfig.LimitAzDeg);
            double cEl = Geo.Clamp(dEl, -DualFrameConfig.LimitElDeg, DualFrameConfig.LimitElDeg);
            if (Math.Abs(cAz - dAz) > 1e-9 || Math.Abs(cEl - dEl) > 1e-9) clamped = true;
            azNew = Geo.Wrap360(azOld + cAz);
            elNew = Geo.Clamp(elOld + cEl,
                              -DualFrameConfig.ElOutputClampDeg, DualFrameConfig.ElOutputClampDeg);
        }

        /// <summary>旧版高度截断公式，仅供历史兼容；当前成功态取主帧可见段中点。</summary>
        public static double HeightSuccess(double zMidCommon, double H)
        {
            return Geo.Clamp(zMidCommon, DualFrameConfig.HeightFloorM, CeilOf(H));
        }

        /// <summary>失败态「新居中高度」：clamp(0.12H, 0.8m, CeilOf(H))。R3 零改动。</summary>
        public static double HeightFallback(double H)
        {
            return Geo.Clamp(DualFrameConfig.HeightK * H, DualFrameConfig.HeightFloorM, CeilOf(H));
        }

        /// <summary>回退态统一高度入口（DEF-02）。R3 零改动。</summary>
        public static double FallbackHeight(double H, double legacyH)
        {
            if (!IsAbnormalHeight(H)) return HeightFallback(H);
            double h = legacyH;
            if (H > 0.0 && h > H) h = H;
            if (h < 0.0) h = 0.0;
            return h;
        }

        /// <summary>旧版红圈锚点高度（仅日志/对照用）。R3 零改动。</summary>
        public static double TrunkMarkHLegacy(double H)
        {
            return Geo.Clamp(DualFrameConfig.LegacyTrunkRatio * H,
                             DualFrameConfig.LegacyTrunkFloorM,
                             DualFrameConfig.LegacyTrunkCeilM);
        }

        /// <summary>树高异常判据（DEF-02）。R3 零改动。</summary>
        public static bool IsAbnormalHeight(double H)
        {
            return double.IsNaN(H) || double.IsInfinity(H)
                || H < DualFrameConfig.HeightFloorM
                || H > DualFrameConfig.HeightAbnormalMaxM;
        }

        /// <summary>上限取 max(下限, min(0.35H, 2.0))，保证 lo ≤ hi。R3 零改动。</summary>
        static double CeilOf(double H)
        {
            return Math.Max(DualFrameConfig.HeightFloorM,
                           Math.Min(DualFrameConfig.HeightCeilRatio * H,
                                    DualFrameConfig.HeightCeilAbsM));
        }

        static double Dot(Vec3 a, Vec3 b)
        {
            return a.X * b.X + a.Y * b.Y + a.Z * b.Z;
        }

        static Vec3 Add(Vec3 a, Vec3 b)
        {
            return new Vec3 { X = a.X + b.X, Y = a.Y + b.Y, Z = a.Z + b.Z };
        }

        static Vec3 Sub(Vec3 a, Vec3 b)
        {
            return new Vec3 { X = a.X - b.X, Y = a.Y - b.Y, Z = a.Z - b.Z };
        }

        static Vec3 Scale(Vec3 a, double s)
        {
            return new Vec3 { X = a.X * s, Y = a.Y * s, Z = a.Z * s };
        }
    }
}
