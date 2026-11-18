using System;

namespace TreeExtractor
{
    /// <summary>
    /// 「自动双帧交会定位」的全部可调阈值与结构常量，集中存放。
    /// R3 定案：TrunkObservation.cs / DualFrameGeometry.cs / DualFrameEngine.cs
    /// 不得出现可调阈值的数值字面量，一律引用本文件。
    /// 角度单位为度、长度单位为米，与 Geo / UtmForest / Proj 既有口径一致。
    /// </summary>
    internal static class DualFrameConfig
    {
        // ===== 开关 / 基础硬约束（R1–R2 定案，R3 不变）=====
        public const bool EnabledDefault = true;
        public const double BaselineAngleMinDeg = 15.0;
        public const double CommonVisibleMinM = 0.2;
        // 启发式保护：两帧观测不能与树位置严重冲突；结果仍需人工核验。
        public const double MinAgreement = 0.15;
        public const double AxisErrorMinM = 0.75;
        public const double AxisErrorMaxM = 2.0;
        public const double AxisErrorDistanceRatio = 0.20;
        public const double SameFlightMaxDeltaSec = 600.0;   // 旧判据，R2 起不再用于配对
        public const double FlightGapSec = 180.0;
        public const double ConfMin = 0.42;              // R3 自调 R2：恢复设计值（离线核对 199/228 ≥160）
        public const double LimitAzDeg = 5.0;
        public const double LimitElDeg = 6.0;
        public const double LimitConfFold = 0.9;
        public const double ResidualMaxM = 1.2;              // R3：仅诊断，不再作回退判据
        public const double BaselineSatDeg = 50.0;
        public const double PeakContrastMin = 0.06;
        public const double PeakContrastScale = 0.20;
        public const double RoiHalfWidthRatio = 0.5;

        // ===== R3 新增：相对偏差一致性融合 =====
        public const double AgreeSigmaAzDeg = 6.0;
        public const double AgreeSigmaElDeg = 8.0;
        public const double RoiMinWinDeg = 3.0;
        public const double RoiMaxWinDeg = 20.0;
        public const double CenterPriorSigma = 0.35;
        public const double UStarMaxRatio = 0.6;
        public const double UStarFold = 0.7;
        public const double QualityWCenter = 0.20;
        public const double FuseWeightAMin = 0.2;
        public const double FuseWeightAMax = 0.8;

        /// <summary>R3 置信度权重：agree / minQ / fBase / poseIntegrity。</summary>
        public static readonly double[] ConfW = new double[] { 0.40, 0.25, 0.20, 0.15 };

        /// <summary>quality 加权和权重（4 项和为 1）。</summary>
        public const double QualityWContrast = 0.40;
        public const double QualityWSegment = 0.25;
        public const double QualityWOcclusion = 0.15;
        public const double QualityOccPenalty = 0.15;

        // ===== 高度（DEF-02，R3 零改动）=====
        public const double HeightK = 0.12;
        public const double HeightFloorM = 0.8;
        public const double HeightCeilRatio = 0.35;
        public const double HeightCeilAbsM = 2.0;
        public const double HeightAbnormalMaxM = 80.0;

        // ===== 读图 / ROI / 性能 =====
        // 主帧最多读一次，辅助帧最多试三张；各帧都必须独立通过相同可靠性门槛。
        public const int MaxSecondaryAttempts = 3;
        public const int MaxExtraFrameLoads = 1 + MaxSecondaryAttempts;
        public const int RoiSmallW = 1440;
        public const int RoiSmallH = 720;
        public const int RoiSmallMinW = 64;
        public const int RoiSmallMinH = 32;
        public const double RoiRowPadRatio = 0.10;
        public const double RoiRowPadMinPx = 4.0;
        public const int RoiExpandPx = 12;
        public const int RoiMinRowsPx = 8;
        public const int RoiMinColsPx = 5;
        public const int RoiMinHalfWidthPx = 8;
        public const double RoiMaxHalfWidthRatio = 0.25;     // W/4
        public const double SegRatioFullFraction = 0.5;
        public const double SegRatioMinRows = 4.0;
        public const int SegmentMinLenPx = 3;            // R3 自调 R1：4 → 3
        // R3 自调 R1：0.35 → 0.15。树干列响应近似均匀时 rMed≈rMax，
        // 旧阈值 rMed+0.35·(rMax−rMed) 使「最长连续高响应段」不足 4 行而误判量测失败；
        // 降低阈值让整段树干被完整检出，属量测鲁棒化，不动反投影/口径。
        public const double SegmentThresholdFraction = 0.15;
        public const double PeakCentroidFraction = 0.45;
        public const int PeakCentroidMinHalfPx = 3;
        public const int PeakCentroidHalfDivisor = 8;

        // ===== 图像响应与颜色判据（数值与 R2 完全一致，仅集中化）=====
        public const int PixelBytesBgr = 3;
        public const int PixelBytesBgra = 4;
        public const double GrayB = 0.114;
        public const double GrayG = 0.587;
        public const double GrayR = 0.299;
        public const double DarkRef = 170.0;
        public const double BrownRef = 80.0;
        public const double GradientNorm = 64.0;
        public const double GradientCap = 2.0;
        public const double ResponseWGradient = 0.6;
        public const double ResponseWDark = 0.5;
        public const double ResponseWBrown = 0.5;

        // ===== 角度 / 投影结构常量（与 BackendSession.Photo.cs / Proj.cs 同口径，不得改符号）=====
        public const double DegPerTurn = 360.0;
        public const double DegPerHalfTurn = 180.0;
        public const double RightAngleDeg = 90.0;
        public const double ElClampDeg = 85.0;
        public const double ElOutputClampDeg = 90.0;
        public const double DhFloorM = 0.5;
        public const double TheoryDhFloorM = 0.5;
        public const double GaussianHalf = 0.5;
        public const double DenominatorTwo = 2.0;
        public const int PoseDofCount = CameraPose.ComponentCount;

        // ===== 数值保护 / 权重下限 =====
        public const double WeightFloor = 1e-6;
        public const double PeakEps = 1e-6;
        public const double CompareEps = 1e-9;
        public const double IntersectEps = 1e-9;
        public const double IntersectDenEps = 1e-6;

        // ===== 副帧选择（SelectB / ScanB，R3 零改动）=====
        public const double SelectWBase = 0.6;
        public const double SelectWQuality = 0.4;
        public const double SelectOccPenalty = 0.3;
        public const double BaselineLenRatio = 0.15;
        public const double NearPoolFactor = 1.3;
        public const double P1WideFactor = 1.6;
        // B 观测失败后，优先尝试不同方向而非同一段轨迹上的相邻帧。
        // 仅影响重试顺序；交会、图像观测和置信度门槛保持不变。
        public const double RetryViewDiversityWeight = 1.2;
        public const double RetryViewDiversitySaturationDeg = 30.0;
        // 图像观测候选及跨帧互证：不可把均匀色块或单条暗边当作已识别树干。
        public const int MaxObservationCandidates = 5;
        public const double ObservationShiftFraction = 0.65;
        public const double ObservationDuplicateDeg = 0.45;
        public const double ObservationMaxSearchDeg = 20.0;
        public const int AppearanceMinRows = 8;
        public const int AppearanceEdgeRadiusPx = 18;
        public const int AppearanceMinWidthPx = 2;
        public const double AppearanceMinEdgeGradient = 4.0;
        public const double AppearanceMinConsistentRows = 0.50;
        public const double AppearanceMinHeightM = 0.40;
        public const double AppearanceMinStd = 4.0;
        public const int AppearanceMinTextureTurns = 3;
        public const double AppearanceTextureTurnEps = 1.0;
        public const double AppearanceMinCorrelation = 0.65;
        public const double AppearanceMaxWidthRatio = 2.0;
        public const double AppearanceMinWidthM = 0.02;
        public const double AppearanceMaxWidthM = 1.20;
        public const int AppearanceHeightSamples = 32;
        public const double NeighborAxisMinMarginM = 0.25;
        public const int ViewClipSamples = 128;
        public const int ViewClipBisections = 24;
        public const double CandidateMinDhM = 2.5;
        public const double CandidateMaxDhM = 30.0;

        // ===== 位姿完整性（DEF-05）=====
        public const double PoseIntegrityFull = 1.0;
        public const double PoseIntegrityImu = 0.8;
        public const double PoseImuEpsilon = 1e-6;

        // ===== 遗留常量（数值与原实现完全一致，仅集中化）=====
        public const double LegacyTrunkRatio = 0.042;
        public const double LegacyTrunkFloorM = 0.42;
        public const double LegacyTrunkCeilM = 0.75;
        public const int BitsPerByte = 8;

        // ===== 回放 CSV =====
        public const string ReplayCsvRelative = "outputs\\双帧交会回放.csv";
    }
}
