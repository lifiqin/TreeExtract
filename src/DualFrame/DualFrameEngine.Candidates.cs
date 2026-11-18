using System;
using System.Collections.Generic;

namespace TreeExtractor
{
    /// <summary>辅助帧候选扫描的结果与判据计数。</summary>
    internal sealed class BScan
    {
        public int NB = 0;
        public int NPose = 0;
        public int NSegment = 0;
        public int NMissingSegment = 0;
        public int NBase = 0;
        public FrameCandidate Best = null;
        public double BestScore = double.NegativeInfinity;
        public double BestBase = 0.0;
    }

    internal static partial class DualFrameEngine
    {
        /// <summary>
        /// 选副帧 B：帧名不同、同架次、有 6DOF 姿态、有效夹角 ≥15°、基线不退化。
        /// 优先近距池，再扩到同段其他候选；候选排序使用几何代理，不预读图片。
        /// </summary>
        public static FrameCandidate SelectB(DualFrameContext ctx, DualFrameInput input,
                                             out FallbackReason reason, out double baselineDeg)
        {
            return SelectB(ctx, input, null, out reason, out baselineDeg);
        }

        static FrameCandidate SelectB(DualFrameContext ctx, DualFrameInput input, HashSet<int> excluded,
                                      out FallbackReason reason, out double baselineDeg)
        {
            reason = FallbackReason.NoCandidateB;
            baselineDeg = 0.0;
            if (ctx == null || input == null || input.Tree == null || input.FrameA == null
                || input.Candidates == null || ctx.MetaPose == null || ctx.Frames == null)
                return null;

            double[] mpA;
            if (!ctx.MetaPose.TryGetValue(input.FrameA.Name, out mpA) || !CameraPose.IsValid(mpA))
            {
                reason = FallbackReason.MissingPose;
                return null;
            }

            int segA = (ctx.SegmentOf == null) ? -1 : ctx.SegmentOf(input.FrameA.Name);
            if (ctx.SegmentOf != null && segA < 0)
            {
                reason = FallbackReason.MissingFlightSegment;
                return null;
            }
            double azTreeA = input.CandA == null
                ? Geo.Wrap360(Geo.Deg(Math.Atan2(input.Tree.X - mpA[0], input.Tree.Y - mpA[1])))
                : Geo.Wrap360(input.CandA.AzT);
            int aIdx = input.CandA == null ? -1 : input.CandA.Index;

            double minDh = double.MaxValue;
            foreach (FrameCandidate c in input.Candidates)
                if (c.Dh < minDh) minDh = c.Dh;
            if (double.IsInfinity(minDh)) minDh = DualFrameConfig.CandidateMaxDhM;

            double nearR = minDh * DualFrameConfig.NearPoolFactor;
            double wideR = Math.Max(minDh * DualFrameConfig.P1WideFactor,
                                    DualFrameConfig.CandidateMaxDhM);
            // 首次仍优先近距；一旦已试过某张 B，不要在近距池反复取相邻帧，
            // 而在原有合法范围内优先尝试不同观察方向（仍由后续图像与几何验证）。
            bool retry = excluded != null && excluded.Count > 0;
            BScan s = ScanB(ctx, input, mpA, segA, azTreeA, aIdx,
                            retry ? wideR : nearR, excluded);
            if (s.Best == null && !retry)
            {
                s = ScanB(ctx, input, mpA, segA, azTreeA, aIdx, wideR, excluded);
            }

            if (s.Best != null)
            {
                reason = FallbackReason.None;
                baselineDeg = s.BestBase;
                return s.Best;
            }

            if (s.NB > 0 && s.NPose > 0 && s.NSegment == 0)
                reason = s.NMissingSegment > 0 ? FallbackReason.MissingFlightSegment : FallbackReason.CrossFlight;
            else if (s.NB > 0 && s.NSegment > 0 && s.NBase == 0) reason = FallbackReason.BaselineTooSmall;
            else if (s.NB > 0 && s.NPose == 0) reason = FallbackReason.MissingPose;
            else reason = FallbackReason.NoCandidateB;
            return null;
        }

        /// <summary>单遍候选扫描：B1 A≠B / B2 6DOF / B3 同架次段 / B4 基线角 / B5 基线长 / B6 质量择优。</summary>
        static BScan ScanB(DualFrameContext ctx, DualFrameInput input, double[] mpA, int segA,
                           double azTreeA, int aIdx, double maxDh, HashSet<int> excluded)
        {
            var s = new BScan();
            foreach (FrameCandidate b in input.Candidates)
            {
                if (b.Index == aIdx) continue;                       // B1
                if (excluded != null && excluded.Contains(b.Index)) continue;
                if (b.Index < 0 || b.Index >= ctx.Frames.Count) continue;
                if (b.Dh > maxDh + 1e-9) continue;
                string name = ctx.Frames[b.Index].Name;
                if (string.Equals(name, input.FrameA.Name, StringComparison.OrdinalIgnoreCase)) continue;
                bool duplicate = false;
                if (excluded != null)
                    foreach (int previous in excluded)
                        if (previous >= 0 && previous < ctx.Frames.Count &&
                            string.Equals(name, ctx.Frames[previous].Name, StringComparison.OrdinalIgnoreCase))
                        { duplicate = true; break; }
                if (duplicate) continue;
                s.NB++;
                double[] mpB;
                if (!ctx.MetaPose.TryGetValue(name, out mpB) || !CameraPose.IsValid(mpB)) continue;  // B2
                s.NPose++;

                // B3：架次段 ID 必须相同（R2 的 GPS 差判据已废弃）。
                if (ctx.SegmentOf != null)
                {
                    int segB = ctx.SegmentOf(name);
                    if (segB < 0) { s.NMissingSegment++; continue; }
                    if (segB != segA) continue;
                }
                s.NSegment++;

                double azTreeB = Geo.Wrap360(b.AzT);
                double bearingDifference = Math.Abs(Geo.Wrap180(azTreeA - azTreeB));
                // 近 0° 和近 180° 都是退化基线，均不能稳定交会。
                double bl = Math.Min(bearingDifference, 180.0 - bearingDifference);
                double camBase = Geo.Dist2D(mpA[0] - mpB[0], mpA[1] - mpB[1]);
                double minBase = DualFrameConfig.BaselineLenRatio *
                                 Math.Min(input.CandA == null ? b.Dh : input.CandA.Dh, b.Dh);
                if (bl < DualFrameConfig.BaselineAngleMinDeg || camBase < minBase) continue;   // B4 + B5
                s.NBase++;

                int occ = 0;
                if (ctx.OcclusionOf != null) occ = ctx.OcclusionOf(input.Tree, mpB, b.Dh);
                b.Occ = occ;
                double normBase = Geo.Clamp((bl - DualFrameConfig.BaselineAngleMinDeg) /
                    Math.Max(1e-6, DualFrameConfig.BaselineSatDeg - DualFrameConfig.BaselineAngleMinDeg), 0.0, 1.0);
                double qProxy = Geo.Clamp(1.0 - b.Dh / DualFrameConfig.CandidateMaxDhM, 0.0, 1.0);
                double score = DualFrameConfig.SelectWBase * normBase
                             + DualFrameConfig.SelectWQuality * qProxy
                             - DualFrameConfig.SelectOccPenalty * occ;
                if (excluded != null && excluded.Count > 0)
                    score += DualFrameConfig.RetryViewDiversityWeight *
                             RetryViewNovelty(input.Candidates, excluded, azTreeB);
                if (score > s.BestScore)
                {
                    s.BestScore = score;
                    s.Best = b;
                    s.BestBase = bl;
                }
            }
            return s;
        }

        // 最相似的已尝试方位决定新 B 的加分；同方位相邻帧不因时间戳不同被当成新视角。
        static double RetryViewNovelty(List<FrameCandidate> candidates, HashSet<int> excluded,
                                       double azimuth)
        {
            double minDifference = 180.0;
            bool compared = false;
            foreach (FrameCandidate previous in candidates)
            {
                if (!excluded.Contains(previous.Index)) continue;
                double difference = Math.Abs(Geo.Wrap180(azimuth - previous.AzT));
                minDifference = Math.Min(minDifference, difference);
                compared = true;
            }
            return compared ? Geo.Clamp(minDifference /
                DualFrameConfig.RetryViewDiversitySaturationDeg, 0.0, 1.0) : 0.0;
        }

    }
}
