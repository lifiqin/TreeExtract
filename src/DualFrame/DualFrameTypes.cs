using System;
using System.Collections.Generic;
using System.Globalization;

namespace TreeExtractor
{
    /// <summary>双帧融合的四种最终状态（枚举值 R3 不变，兼容 QA 计数脚本）。</summary>
    internal enum DualFrameStatus
    {
        Disabled,
        ManualSkipped,
        Success,
        Fallback
    }

    /// <summary>回退/跳过原因，供状态栏、日志、回放 CSV 统一核对。</summary>
    internal enum FallbackReason
    {
        None,
        NoCandidateB,
        BaselineTooSmall,
        CrossFlight,
        MissingFlightSegment,
        MissingPose,
        MissingTrunkCsv,
        ObservationFailed,
        PrimaryObservationFailed,
        SecondaryObservationFailed,
        PrimaryObservationOperatorRisk,
        SecondaryObservationOperatorRisk,
        PrimaryTooClose,
        NoCommonVisibleTrunk,
        InconsistentAxis,
        AmbiguousTarget,
        InconsistentAppearance,
        ResidualTooLarge,
        LowConfidence,
        AbnormalHeight,
        LimitExceeded,
        Exception
    }

    /// <summary>三维点/向量（米）。</summary>
    internal struct Vec3
    {
        public double X;
        public double Y;
        public double Z;
    }

    /// <summary>三维射线：O 为相机位置，D 为单位方向向量。</summary>
    internal struct Ray3
    {
        public Vec3 O;
        public Vec3 D;
    }

    /// <summary>
    /// R3：一帧图像量测的完整结果。Ray 仅为诊断（求残差写日志/CSV），不参与定位。
    /// </summary>
    internal struct TrunkMeasure
    {
        public double AzPix;             // 量测世界方位角（度），与 c.A0/cal 同一角度空间
        public double ElPix;             // 量测世界仰角（度）
        public double ElTop;             // 可见段上界对应世界仰角（度）
        public double ElBot;             // 可见段下界对应世界仰角（度）
        public double ZBot;              // 可见段下界相对树底 t.Z 的高度（米）
        public double ZTop;              // 可见段上界相对树底 t.Z 的高度（米）
        public double Quality;           // [0,1] 综合质量（已含峰到中心距离因子）
        public double PeakContrast;      // [0,1] 归一化峰对比度，供融合权重 w
        public double PeakOffsetRatio;   // |uStar − cx| / rw
        public double WidthDeg;          // 左右边缘估计的全景角宽（度）
        public float[] GrayProfile;      // 自上而下的中心纹理；按 ElTop / ElBot 对齐
        public Ray3 Ray;                 // 仅诊断：Intersect 求 residualM
    }

    /// <summary>R3：融合诊断量，写入 DualFrameResult，供日志/回放 CSV/离线扫参。</summary>
    internal struct FusionDiagnostics
    {
        public double DAzA;
        public double DAzB;
        public double DElA;
        public double DElB;
        public double Agree;
        public double WeightA;
        public double ResidualM;
        public double AxisErrorM;
        public double AxisLimitM;
        public double AppearanceCorrelation;
        public string AppearanceStatus;
    }

    /// <summary>一次副帧尝试中，最深入的候选配对诊断；数值不可用时为 NaN。</summary>
    internal sealed class DualFrameAttemptDiagnostics
    {
        public readonly string FrameB;
        public readonly int PrimaryCandidates;
        public readonly int SecondaryCandidates;
        public readonly FallbackReason Reason;
        public readonly double AxisErrorM;
        public readonly double AxisLimitM;
        public readonly double AppearanceCorrelation;
        public readonly string AppearanceStatus;

        public DualFrameAttemptDiagnostics(string frameB, int primaryCandidates, int secondaryCandidates,
                                           FallbackReason reason, double axisErrorM, double axisLimitM,
                                           double appearanceCorrelation, string appearanceStatus)
        {
            FrameB = frameB ?? "";
            PrimaryCandidates = primaryCandidates;
            SecondaryCandidates = secondaryCandidates;
            Reason = reason;
            AxisErrorM = axisErrorM;
            AxisLimitM = axisLimitM;
            AppearanceCorrelation = appearanceCorrelation;
            AppearanceStatus = appearanceStatus ?? "not_attempted";
        }
    }

    /// <summary>
    /// 双帧融合的统一响应体。Recompute 写入、UpdateTreeMark 读锚点、
    /// AppendDualFrameStatus 读状态串，三处消费者不得自行重算。
    /// </summary>
    internal class DualFrameResult
    {
        public DualFrameStatus Status;
        public FallbackReason Reason;
        public string FrameA;
        public string FrameB;
        public double BaselineAngleDeg;
        public double ResidualM;            // R3：诊断值，不再作回退判据
        public double Confidence;
        public double AzOld;
        public double ElOld;
        public double AzNew;
        public double ElNew;
        public double HeightM;
        public bool LimitClamped;
        public int PairAttempts;
        public IReadOnlyList<DualFrameAttemptDiagnostics> Attempts = Array.Empty<DualFrameAttemptDiagnostics>();
        // 仅成功配对可能具有图证；由胜出的观测生成，不保留图像或纹理数组。
        internal DualFramePairEvidence Evidence;

        /// <summary>R3 融合诊断。</summary>
        public FusionDiagnostics Fusion;

        /// <summary>回退原因的中文短标签（单行）。</summary>
        public string ReasonText
        {
            get
            {
                switch (Reason)
                {
                    case FallbackReason.None: return "无";
                    case FallbackReason.NoCandidateB: return "无合格副帧";
                    case FallbackReason.BaselineTooSmall: return "基线角/基线长过小";
                    case FallbackReason.CrossFlight: return "跨架次（架次段不同）";
                    case FallbackReason.MissingFlightSegment: return "相机帧缺少架次段信息";
                    case FallbackReason.MissingPose: return "缺 6DOF 姿态";
                    case FallbackReason.MissingTrunkCsv: return "缺树干轴心数据";
                    case FallbackReason.ObservationFailed: return "图像量测失败";
                    case FallbackReason.PrimaryObservationFailed: return "主帧未能可靠量测树干";
                    case FallbackReason.SecondaryObservationFailed: return "辅助帧未能可靠量测树干";
                    case FallbackReason.PrimaryObservationOperatorRisk: return "主帧观测位于疑似拍摄者区域，未做人像检测";
                    case FallbackReason.SecondaryObservationOperatorRisk: return "辅助帧观测位于疑似拍摄者区域，未做人像检测";
                    case FallbackReason.PrimaryTooClose: return "主帧距树干过近，无法可靠量测";
                    case FallbackReason.NoCommonVisibleTrunk: return "主帧中点缺少辅助帧可靠验证";
                    case FallbackReason.InconsistentAxis: return "两帧树干方向与树位置不一致";
                    case FallbackReason.AmbiguousTarget: return "交会位置无法排除相邻树";
                    case FallbackReason.InconsistentAppearance: return "两帧纹理或树干宽度未能相互验证";
                    case FallbackReason.ResidualTooLarge: return "交会残差过大";
                    case FallbackReason.LowConfidence: return "置信度不足";
                    case FallbackReason.AbnormalHeight: return "树高异常";
                    case FallbackReason.LimitExceeded: return "限幅折减后置信度不足";
                    case FallbackReason.Exception: return "异常保护回退";
                    default: return "未知原因";
                }
            }
        }

        /// <summary>
        /// 单行状态串：A/B 帧名 + 基线角 + 置信度 + 状态（四要素），
        /// 成功/回退态在状态文案后追加融合诊断值，供状态栏/日志/CSV 三方对账。
        /// </summary>
        public string StatusText
        {
            get
            {
                string a = string.IsNullOrEmpty(FrameA) ? "-" : FrameA;
                string b = string.IsNullOrEmpty(FrameB) ? "-" : FrameB;
                string st;
                switch (Status)
                {
                    case DualFrameStatus.Disabled:
                        st = "关闭（单帧模式）";
                        break;
                    case DualFrameStatus.ManualSkipped:
                        st = "已跳过（人工校正优先）";
                        break;
                    case DualFrameStatus.Success:
                        st = "两帧几何及纹理互证 4:3 候选可见段中点，需目视复核";
                        break;
                    default:
                        st = "回退单帧（" + ReasonText + "）| 高度为估计值，请校正";
                        break;
                }
                string diag = "";
                if (Status == DualFrameStatus.Success
                    || (Status == DualFrameStatus.Fallback && Fusion.Agree > 0.0))
                {
                    diag = string.Format(CultureInfo.InvariantCulture,
                        " | 诊断 dAz={0:F1}/{1:F1} dEl={2:F1}/{3:F1} 几何一致性={4:F2}",
                        Fusion.DAzA, Fusion.DAzB, Fusion.DElA, Fusion.DElB,
                        Fusion.Agree);
                }
                return string.Format(CultureInfo.InvariantCulture,
                    "双帧: A={0} / B={1} | 有效基线角 {2:F1}° | 评分 {3:F2} | 尝试 {4} | {5}",
                    a, b, BaselineAngleDeg, Confidence, PairAttempts, st + diag);
            }
        }
    }

    /// <summary>
    /// 缓存键包含树、相机、校正与实际 4:3 光轴/投影，避免沿用旧画幅的中点。
    /// 全部字段 readonly，构造后不可变（等价于 readonly struct，兼容本工程的 C# 5 编译器）。
    /// </summary>
    internal struct DualFrameCacheKey : IEquatable<DualFrameCacheKey>
    {
        public readonly int TreeId;
        public readonly double Cal;
        public readonly double CalV;
        public readonly string FrameA;
        public readonly string DataSetId;
        public readonly double PhotoBearing;
        public readonly double PhotoElevation;
        public readonly bool LevelView;
        public readonly double ProjectionD;

        public DualFrameCacheKey(int treeId, double cal, double calV, string frameA, string dataSetId)
            : this(treeId, cal, calV, frameA, dataSetId, 0.0, 0.0, false, 0.0)
        {
        }

        public DualFrameCacheKey(int treeId, double cal, double calV, string frameA, string dataSetId,
                                 double photoBearing, double photoElevation, bool levelView, double projectionD)
        {
            TreeId = treeId;
            Cal = cal;
            CalV = calV;
            FrameA = frameA == null ? string.Empty : frameA;
            DataSetId = dataSetId == null ? string.Empty : dataSetId;
            PhotoBearing = photoBearing;
            PhotoElevation = photoElevation;
            LevelView = levelView;
            ProjectionD = projectionD;
        }

        public bool Equals(DualFrameCacheKey other)
        {
            return TreeId == other.TreeId
                && Cal.Equals(other.Cal)
                && CalV.Equals(other.CalV)
                && PhotoBearing.Equals(other.PhotoBearing)
                && PhotoElevation.Equals(other.PhotoElevation)
                && LevelView == other.LevelView
                && ProjectionD.Equals(other.ProjectionD)
                && string.Equals(FrameA, other.FrameA, StringComparison.OrdinalIgnoreCase)
                && string.Equals(DataSetId, other.DataSetId, StringComparison.Ordinal);
        }

        public override bool Equals(object obj)
        {
            return (obj is DualFrameCacheKey) && Equals((DualFrameCacheKey)obj);
        }

        public override int GetHashCode()
        {
            unchecked
            {
                int h = TreeId;
                h = h * 397 ^ Cal.GetHashCode();
                h = h * 397 ^ CalV.GetHashCode();
                h = h * 397 ^ PhotoBearing.GetHashCode();
                h = h * 397 ^ PhotoElevation.GetHashCode();
                h = h * 397 ^ LevelView.GetHashCode();
                h = h * 397 ^ ProjectionD.GetHashCode();
                h = h * 397 ^ StringComparer.OrdinalIgnoreCase.GetHashCode(FrameA ?? string.Empty);
                h = h * 397 ^ (DataSetId == null ? 0 : DataSetId.GetHashCode());
                return h;
            }
        }

        public static bool operator ==(DualFrameCacheKey a, DualFrameCacheKey b)
        {
            return a.Equals(b);
        }

        public static bool operator !=(DualFrameCacheKey a, DualFrameCacheKey b)
        {
            return !a.Equals(b);
        }
    }
}
