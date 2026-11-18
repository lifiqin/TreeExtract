using System;
using System.Collections.Generic;
using System.Drawing;

namespace TreeExtractor
{
    /// <summary>
    /// 双帧编排：自动选副帧、分别量测、水平交会、验证主帧可见段中点，并显式回退。
    /// 任何异常都在 Prepare 内转成 Fallback(Exception)，不向 UI 抛。
    /// </summary>
    internal static partial class DualFrameEngine
    {
        /// <summary>检查 A/B 观测几何；主帧可见段中点须在辅助帧可见范围内。</summary>
        static DualFrameResult EvaluatePair(DualFrameContext ctx, DualFrameInput input, FrameCandidate b,
                                            double[] mpA, double[] mpB, TrunkMeasure mA, TrunkMeasure mB,
                                            double baselineDeg, string nameB)
        {
            // 两帧各自段中点并非同一三维点：该残差仅供诊断，无解时标记为未知。
            Vec3 pMid;
            double residualM;
            if (!DualFrameGeometry.Intersect(mA.Ray, mB.Ray, out pMid, out residualM))
                residualM = double.NaN;
            var diag = new FusionDiagnostics {
                ResidualM = residualM, AxisErrorM = double.NaN, AxisLimitM = double.NaN,
                AppearanceCorrelation = double.NaN, AppearanceStatus = "not_attempted"
            };

            double trunkX, trunkY;
            if (!DualFrameGeometry.TryIntersectHorizontal(mpA, mA.AzPix, mpB, mB.AzPix,
                                                          out trunkX, out trunkY))
                return PairFallback(ctx, input, FallbackReason.InconsistentAxis, baselineDeg, nameB, diag);
            double[] expectedAxis = ctx.TrunkAxisOf == null ? null : ctx.TrunkAxisOf(input.Tree);
            double expectedX = expectedAxis != null && expectedAxis.Length >= 2 ? expectedAxis[0] : input.Tree.X;
            double expectedY = expectedAxis != null && expectedAxis.Length >= 2 ? expectedAxis[1] : input.Tree.Y;
            double axisError = Geo.Dist2D(trunkX - expectedX, trunkY - expectedY);
            double axisLimit = Geo.Clamp(DualFrameConfig.AxisErrorDistanceRatio * Math.Min(input.CandA.Dh, b.Dh),
                                         DualFrameConfig.AxisErrorMinM, DualFrameConfig.AxisErrorMaxM);
            diag.AxisErrorM = axisError;
            diag.AxisLimitM = axisLimit;
            if (double.IsNaN(axisError) || double.IsInfinity(axisError) || axisError > axisLimit)
                return PairFallback(ctx, input, FallbackReason.InconsistentAxis, baselineDeg, nameB, diag);
            if (ctx.AxisConflictsNeighbor != null && ctx.AxisConflictsNeighbor(input.Tree, trunkX, trunkY))
                return PairFallback(ctx, input, FallbackReason.AmbiguousTarget, baselineDeg, nameB, diag);

            // 用交会轴心到两相机各自的距离换算观测段高度，保证前后投影同口径。
            double dhA = Geo.Dist2D(trunkX - mpA[0], trunkY - mpA[1]);
            double dhB = Geo.Dist2D(trunkX - mpB[0], trunkY - mpB[1]);
            mA.ZBot = mpA[2] + dhA * Math.Tan(Geo.Rad(mA.ElBot)) - input.Tree.Z;
            mA.ZTop = mpA[2] + dhA * Math.Tan(Geo.Rad(mA.ElTop)) - input.Tree.Z;
            mB.ZBot = mpB[2] + dhB * Math.Tan(Geo.Rad(mB.ElBot)) - input.Tree.Z;
            mB.ZTop = mpB[2] + dhB * Math.Tan(Geo.Rad(mB.ElTop)) - input.Tree.Z;
            double zLow, zHigh, hMark;
            if (!DualFrameGeometry.TryImageVisibleMidpoint(mA, mB, input.Tree.Height, input.Tree.Z,
                                                           mpA, trunkX, trunkY, ctx.ProjectPrimary,
                                                           out zLow, out zHigh, out hMark))
                return PairFallback(ctx, input, FallbackReason.NoCommonVisibleTrunk, baselineDeg, nameB, diag);
            double appearance;
            string appearanceStatus;
            if (!TrunkAppearance.Agree(mA, mB, mpA, mpB, dhA, dhB, input.Tree.Z,
                                       zLow, zHigh, out appearance, out appearanceStatus))
            {
                diag.AppearanceCorrelation = appearance;
                diag.AppearanceStatus = appearanceStatus;
                return PairFallback(ctx, input, FallbackReason.InconsistentAppearance, baselineDeg, nameB, diag);
            }
            diag.AppearanceCorrelation = appearance;
            diag.AppearanceStatus = appearanceStatus;

            double azTheoryA = Geo.Wrap360(input.CandA.AzT);
            double azTheoryB = Geo.Wrap360(b.AzT);
            double elTheoryA = DualFrameGeometry.TheoryElevation(input.Tree, mpA, dhA, hMark);
            double elTheoryB = DualFrameGeometry.TheoryElevation(input.Tree, mpB, dhB, hMark);
            double dAzA, dElA, dAzB, dElB;
            DualFrameGeometry.Deviations(mA, azTheoryA, elTheoryA, out dAzA, out dElA);
            DualFrameGeometry.Deviations(mB, azTheoryB, elTheoryB, out dAzB, out dElB);
            // 角偏差会因视点/可见段不同而反号，不能把它们的差当成真实不一致。
            double agree = DualFrameGeometry.GeometricAgreement(mA, mB, zLow, zHigh, axisError, axisLimit);
            double conf = DualFrameGeometry.Confidence(agree, mA.Quality, mB.Quality, baselineDeg,
                                                       DualFrameGeometry.PoseIntegrityOf(mpA, mpB));
            diag.DAzA = dAzA; diag.DAzB = dAzB; diag.DElA = dElA; diag.DElB = dElB;
            diag.Agree = agree; diag.WeightA = DualFrameGeometry.FusionWeight(mA, mB);
            if (agree < DualFrameConfig.MinAgreement || conf < DualFrameConfig.ConfMin)
            {
                DualFrameResult fallback = MakeFallback(ctx, input, FallbackReason.LowConfidence,
                                                        baselineDeg, nameB, residualM, conf);
                fallback.Fusion = diag;
                return fallback;
            }

            double azNew, elNew, distanceNew;
            UtmForest.TreeAzim(trunkX, trunkY, input.Tree.Z + hMark,
                               mpA[0], mpA[1], mpA[2], out azNew, out elNew, out distanceNew);
            return new DualFrameResult {
                Status = DualFrameStatus.Success, Reason = FallbackReason.None,
                FrameA = input.FrameA.Name, FrameB = nameB, BaselineAngleDeg = baselineDeg,
                ResidualM = residualM, Confidence = conf, AzOld = input.AzOld, ElOld = input.ElOld,
                AzNew = azNew, ElNew = elNew, HeightM = hMark, LimitClamped = false, Fusion = diag
            };
        }

        static DualFrameResult PairFallback(DualFrameContext ctx, DualFrameInput input,
                                             FallbackReason reason, double baseline, string name,
                                             FusionDiagnostics diagnostics)
        {
            DualFrameResult result = MakeFallback(ctx, input, reason, baseline, name,
                                                  diagnostics.ResidualM, 0.0);
            result.Fusion = diagnostics;
            return result;
        }

        /// <summary>
        /// Disabled/ManualSkipped 保留历史人工校正口径；自动量测失败则使用估计值并报告原因。
        /// </summary>
        public static DualFrameResult Prepare(DualFrameContext ctx, DualFrameInput input,
                                             out bool cacheHit, out int extraLoads)
        {
            cacheHit = false;
            extraLoads = 0;
            try
            {
                if (ctx == null || input == null || input.Tree == null || input.FrameA == null
                    || ctx.MetaPose == null)
                    return MakeFallback(ctx, input, FallbackReason.MissingPose, 0.0, "", 0.0, 0.0);

                if (!ctx.Enabled)
                    return MakeSkipped(input, DualFrameStatus.Disabled, ctx.TrunkMarkHOf);
                if (ctx.Manual)
                    return MakeSkipped(input, DualFrameStatus.ManualSkipped, ctx.TrunkMarkHOf);

                var key = new DualFrameCacheKey(input.Tree.Id, ctx.Cal, ctx.CalV,
                                                input.FrameA.Name, ctx.DataSetId, ctx.PhotoBearing,
                                                ctx.PhotoElevation, ctx.LevelView, ctx.ProjectionD);
                DualFrameResult cached;
                if (input.Cache != null && input.Cache.TryGetValue(key, out cached))
                {
                    if (cached != null &&
                        (cached.Status == DualFrameStatus.Success || cached.Status == DualFrameStatus.Fallback))
                    {
                        cacheHit = true;
                        return cached;
                    }
                }

                double H = input.Tree.Height;
                if (DualFrameGeometry.IsAbnormalHeight(H))
                    return Finish(input, key, MakeFallback(ctx, input, FallbackReason.AbnormalHeight,
                                                           0.0, "", 0.0, 0.0));

                double[] mpA;
                if (!ctx.MetaPose.TryGetValue(input.FrameA.Name, out mpA) || !CameraPose.IsValid(mpA))
                    return Finish(input, key, MakeFallback(ctx, input, FallbackReason.MissingPose,
                                                           0.0, "", 0.0, 0.0));
                if (input.CandA == null)
                    return Finish(input, key, MakeFallback(ctx, input, FallbackReason.PrimaryTooClose,
                                                           0.0, "", double.NaN, 0.0));
                if (ctx.LoadSmallFrame == null || ctx.Frames == null)
                    return Finish(input, key, MakeFallback(ctx, input, FallbackReason.PrimaryObservationFailed,
                                                           0.0, "", double.NaN, 0.0));

                // A 只读取和量测一次；B 依次尝试，但任何一对都不能跳过可靠性门槛。
                var tried = new HashSet<int>();
                var diagnostics = new List<DualFrameAttemptDiagnostics>();
                List<TrunkMeasure> observationsA = null;
                EvidenceImageHash sourceAHash = null;
                DualFrameResult lastFailure = null;
                for (int attempt = 1; attempt <= DualFrameConfig.MaxSecondaryAttempts; attempt++)
                {
                    FallbackReason reason;
                    double baselineDeg;
                    FrameCandidate b = SelectB(ctx, input, tried, out reason, out baselineDeg);
                    if (b == null)
                    {
                        if (lastFailure != null) return Finish(input, key, WithAttempts(lastFailure, diagnostics));
                        return Finish(input, key, MakeFallback(ctx, input, reason,
                                                               baselineDeg, "", double.NaN, 0.0));
                    }
                    tried.Add(b.Index);
                    string nameB = ctx.Frames[b.Index].Name;
                    double[] mpB = ctx.MetaPose[nameB];

                    if (observationsA == null)
                    {
                        if (ctx.OcclusionOf != null)
                            input.CandA.Occ = ctx.OcclusionOf(input.Tree, mpA, input.CandA.Dh);
                        if (ctx.IsFrameCached == null || !ctx.IsFrameCached(input.FrameA.Name)) extraLoads++;
                        using (Bitmap smallA = ctx.LoadSmallFrame(input.FrameA.Name))
                        {
                            observationsA = TrunkAppearance.Candidates(
                                smallA, input.Tree, input.CandA, mpA, ctx.Cal, ctx.CalV);
                            int riskyA = RemoveRiskyObservations(ctx, input.CandA, observationsA);
                            if (observationsA.Count == 0)
                                return Finish(input, key, MakeFallback(ctx, input, riskyA > 0
                                    ? FallbackReason.PrimaryObservationOperatorRisk : FallbackReason.PrimaryObservationFailed,
                                                                       baselineDeg, "", double.NaN, 0.0));
                            sourceAHash = DualFrameImageEvidence.Fingerprint(smallA);
                        }
                    }

                    if (ctx.IsFrameCached == null || !ctx.IsFrameCached(nameB)) extraLoads++;
                    List<TrunkMeasure> observationsB;
                    EvidenceImageHash sourceBHash = null;
                    using (Bitmap smallB = ctx.LoadSmallFrame(nameB))
                    {
                        observationsB = TrunkAppearance.Candidates(
                            smallB, input.Tree, b, mpB, ctx.Cal, ctx.CalV);
                        int riskyB = RemoveRiskyObservations(ctx, b, observationsB);
                        if (observationsB.Count == 0)
                        {
                            lastFailure = MakeFallback(ctx, input, riskyB > 0
                                ? FallbackReason.SecondaryObservationOperatorRisk : FallbackReason.SecondaryObservationFailed,
                                                       baselineDeg, nameB, double.NaN, 0.0);
                            lastFailure.PairAttempts = attempt;
                            diagnostics.Add(new DualFrameAttemptDiagnostics(nameB, observationsA.Count, 0,
                                lastFailure.Reason, double.NaN, double.NaN, double.NaN, "not_attempted"));
                            continue;
                        }
                        sourceBHash = DualFrameImageEvidence.Fingerprint(smallB);
                    }
                    DualFrameResult bestSuccess = null;
                    DualFrameResult bestFailure = null;
                    TrunkMeasure selectedA = new TrunkMeasure(), selectedB = new TrunkMeasure();
                    foreach (TrunkMeasure mA in observationsA)
                    {
                        foreach (TrunkMeasure mB in observationsB)
                        {
                            DualFrameResult evaluated = EvaluatePair(ctx, input, b, mpA, mpB,
                                                                     mA, mB, baselineDeg, nameB);
                            evaluated.PairAttempts = attempt;
                            if (evaluated.Status == DualFrameStatus.Success)
                            {
                                if (bestSuccess == null || evaluated.Confidence > bestSuccess.Confidence)
                                {
                                    bestSuccess = evaluated;
                                    selectedA = mA;
                                    selectedB = mB;
                                }
                            }
                            else if (bestFailure == null || MoreInformativeFailure(evaluated, bestFailure))
                                bestFailure = evaluated;
                        }
                    }
                    DualFrameResult summary = bestSuccess ?? bestFailure;
                    diagnostics.Add(new DualFrameAttemptDiagnostics(nameB, observationsA.Count,
                        observationsB.Count, summary.Reason, summary.Fusion.AxisErrorM,
                        summary.Fusion.AxisLimitM, summary.Fusion.AppearanceCorrelation,
                        summary.Fusion.AppearanceStatus));
                    if (bestSuccess != null)
                    {
                        bestSuccess.Evidence = CreateSuccessEvidence(ctx, input, b, nameB, attempt,
                                                                     selectedA, selectedB, sourceAHash, sourceBHash);
                        return Finish(input, key, WithAttempts(bestSuccess, diagnostics));
                    }
                    lastFailure = bestFailure;
                }
                return Finish(input, key, WithAttempts(lastFailure, diagnostics));
            }
            catch (Exception ex)
            {
                if (ctx != null && ctx.Log != null)
                    ctx.Log("双帧 异常转回退: " + ex);
                return MakeFallback(ctx, input, FallbackReason.Exception, 0.0, "", 0.0, 0.0);
            }
        }

        // 只复制胜出配对的几何值和源图哈希；图证生成失败不能改变原有定位结果。
        static DualFramePairEvidence CreateSuccessEvidence(DualFrameContext ctx, DualFrameInput input,
                                                            FrameCandidate b, string nameB, int attempt,
                                                            TrunkMeasure a, TrunkMeasure measureB,
                                                            EvidenceImageHash hashA, EvidenceImageHash hashB)
        {
            try
            {
                if (ctx == null || input == null || input.Tree == null || input.FrameA == null ||
                    input.CandA == null || b == null || string.IsNullOrEmpty(ctx.DataSetId) ||
                    string.IsNullOrEmpty(nameB) || attempt < 1 || attempt > DualFrameConfig.MaxSecondaryAttempts ||
                    !IsFinite(ctx.Cal) || !IsFinite(ctx.CalV) || !IsFinite(ctx.ProjectionD) ||
                    string.Equals(input.FrameA.Name, nameB, StringComparison.OrdinalIgnoreCase)) return null;
                var oa = DualFrameObservationEvidence.Create(input.FrameA.Name, a, input.CandA.A0, ctx.CalV, hashA);
                var ob = DualFrameObservationEvidence.Create(nameB, measureB, b.A0, ctx.CalV, hashB);
                return oa == null || ob == null ? null :
                    new DualFramePairEvidence(input.Tree, ctx, input.FrameA.Name, nameB, attempt, oa, ob);
            }
            catch (Exception ex)
            {
                if (ctx != null && ctx.Log != null) ctx.Log("双帧 成功图证不可用: " + ex.Message);
                return null;
            }
        }

        static int RemoveRiskyObservations(DualFrameContext ctx, FrameCandidate candidate,
                                           List<TrunkMeasure> observations)
        {
            if (ctx.ObservationAtOperatorRisk == null) return 0;
            return observations.RemoveAll(delegate(TrunkMeasure observation)
            {
                return ctx.ObservationAtOperatorRisk(candidate, observation);
            });
        }

        // 选择最深入的失败而非最后枚举的组合；这样诊断不会随候选遍历顺序随机变化。
        static int FailureProgress(DualFrameResult result)
        {
            switch (result.Reason)
            {
                case FallbackReason.InconsistentAxis: return 1;
                case FallbackReason.AmbiguousTarget: return 2;
                case FallbackReason.NoCommonVisibleTrunk: return 3;
                case FallbackReason.InconsistentAppearance: return 4;
                case FallbackReason.LowConfidence: return 5;
                default: return 0;
            }
        }

        static bool MoreInformativeFailure(DualFrameResult candidate, DualFrameResult previous)
        {
            int a = FailureProgress(candidate), b = FailureProgress(previous);
            if (a != b) return a > b;
            bool candidateCorrelation = IsFinite(candidate.Fusion.AppearanceCorrelation);
            bool previousCorrelation = IsFinite(previous.Fusion.AppearanceCorrelation);
            if (candidateCorrelation != previousCorrelation) return candidateCorrelation;
            if (candidateCorrelation && candidate.Fusion.AppearanceCorrelation != previous.Fusion.AppearanceCorrelation)
                return candidate.Fusion.AppearanceCorrelation > previous.Fusion.AppearanceCorrelation;
            bool candidateAxis = IsFinite(candidate.Fusion.AxisErrorM);
            bool previousAxis = IsFinite(previous.Fusion.AxisErrorM);
            if (candidateAxis != previousAxis) return candidateAxis;
            return candidateAxis && candidate.Fusion.AxisErrorM < previous.Fusion.AxisErrorM;
        }

        static bool IsFinite(double value) { return !double.IsNaN(value) && !double.IsInfinity(value); }

        static DualFrameResult WithAttempts(DualFrameResult result, List<DualFrameAttemptDiagnostics> attempts)
        {
            if (result != null) result.Attempts = new List<DualFrameAttemptDiagnostics>(attempts).AsReadOnly();
            return result;
        }

        /// <summary>
        /// 失败态使用经验高度及轴心坐标；缺轴心时使用树心方向，不代表可见段已被识别。
        /// </summary>
        internal static DualFrameResult MakeFallback(DualFrameContext ctx, DualFrameInput input,
                                                     FallbackReason reason, double baselineDeg,
                                                     string frameB, double residualM, double confidence)
        {
            var r = new DualFrameResult();
            r.Status = DualFrameStatus.Fallback;
            r.Reason = reason;
            r.FrameA = (input == null || input.FrameA == null) ? "-" : input.FrameA.Name;
            r.FrameB = frameB == null ? "" : frameB;
            r.BaselineAngleDeg = baselineDeg;
            r.ResidualM = residualM;
            r.Confidence = confidence;
            r.AzOld = input == null ? 0.0 : input.AzOld;
            r.ElOld = input == null ? 0.0 : input.ElOld;
            r.AzNew = r.AzOld;
            r.ElNew = r.ElOld;
            double hRaw = (input == null || input.Tree == null) ? 0.0 : input.Tree.Height;
            double legacyH = (ctx != null && ctx.TrunkMarkHOf != null)
                ? ctx.TrunkMarkHOf(hRaw) : DualFrameGeometry.TrunkMarkHLegacy(hRaw);
            r.HeightM = DualFrameGeometry.FallbackHeight(hRaw, legacyH);
            r.LimitClamped = false;
            try
            {
                UtmTree t = input == null ? null : input.Tree;
                if (t == null) return r;
                double x = t.X, y = t.Y;
                bool hasAxis = false;
                if (ctx != null && ctx.TrunkAxisOf != null)
                {
                    double[] axis = ctx.TrunkAxisOf(t);
                    if (axis != null && axis.Length >= 2)
                    {
                        x = axis[0];
                        y = axis[1];
                        hasAxis = true;
                    }
                }
                double[] mpA = null;
                if (ctx != null && ctx.MetaPose != null && input.FrameA != null)
                    ctx.MetaPose.TryGetValue(input.FrameA.Name, out mpA);
                if (mpA != null && mpA.Length >= DualFrameConfig.PoseDofCount)
                {
                    double az, el, d;
                    UtmForest.TreeAzim(x, y, t.Z + r.HeightM, mpA[0], mpA[1], mpA[2],
                                       out az, out el, out d);
                    // 无轴心时没有足够证据套用固定方位偏置，退回树心方向。
                    r.AzNew = hasAxis ? az : Geo.Wrap360(input.AzA);
                    r.ElNew = el;
                }
            }
            catch (Exception)
            {
                r.AzNew = r.AzOld;
                r.ElNew = r.ElOld;
            }
            return r;
        }

        /// <summary>开关关闭 / 人工优先两态：逐像素沿用旧 TrunkMarkH + 旧自动锚点。</summary>
        static DualFrameResult MakeSkipped(DualFrameInput input, DualFrameStatus status,
                                           Func<double, double> legacyH)
        {
            var r = new DualFrameResult();
            r.Status = status;
            r.Reason = FallbackReason.None;
            r.FrameA = input.FrameA == null ? "-" : input.FrameA.Name;
            r.FrameB = "";
            r.BaselineAngleDeg = 0.0;
            r.ResidualM = 0.0;
            r.Confidence = 0.0;
            r.AzOld = input.AzOld;
            r.ElOld = input.ElOld;
            r.AzNew = input.AzOld;
            r.ElNew = input.ElOld;
            r.HeightM = legacyH != null
                ? legacyH(input.Tree.Height)
                : DualFrameGeometry.TrunkMarkHLegacy(input.Tree.Height);
            r.LimitClamped = false;
            return r;
        }

        /// <summary>写缓存（仅 Success/Fallback 需要缓存，跳过态每次即时判定）。</summary>
        static DualFrameResult Finish(DualFrameInput input, DualFrameCacheKey key, DualFrameResult r)
        {
            if (input != null && input.Cache != null &&
                (r.Status == DualFrameStatus.Success || r.Status == DualFrameStatus.Fallback))
                input.Cache[key] = r;
            return r;
        }

    }
}
