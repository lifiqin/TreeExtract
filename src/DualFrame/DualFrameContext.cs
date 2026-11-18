using System;
using System.Collections.Generic;
using System.Drawing;

namespace TreeExtractor
{
    /// <summary>会话向双帧引擎提供的数据、投影及只读回调。</summary>
    internal sealed class DualFrameContext
    {
        public List<FrameInfo> Frames;
        public Dictionary<string, double[]> MetaPose;
        public double Cal;
        public double CalV;
        public double PhotoBearing;
        public double PhotoElevation;
        public bool LevelView;
        public double ProjectionD;
        public string DataSetId;
        public bool Enabled;
        public bool Manual;
        public Func<string, Bitmap> LoadSmallFrame;
        public Func<string, bool> IsFrameCached;
        public Func<UtmTree, double[]> TrunkAxisOf;
        // 输入世界方位/仰角，输出主帧真实 4:3 投影的归一化坐标；不可投影返回 null。
        public Func<double, double, double[]> ProjectPrimary;
        // 交会位置若无法与邻树轴区分，应判为歧义而不能视为成功。
        public Func<UtmTree, double, double, bool> AxisConflictsNeighbor;
        // 经验区域只用于拒绝可疑观测；区域外不意味着已经进行了人像检测。
        public Func<FrameCandidate, TrunkMeasure, bool> ObservationAtOperatorRisk;
        public Func<double, double> TrunkMarkHOf;
        public Func<UtmTree, double[], double, int> OcclusionOf;
        public Func<string, int> SegmentOf;
        public Action<string> Log;
    }

    /// <summary>一次双帧计算的主帧、候选和缓存。</summary>
    internal sealed class DualFrameInput
    {
        public UtmTree Tree;
        public FrameInfo FrameA;
        public FrameCandidate CandA;
        public List<FrameCandidate> Candidates;
        public double AzA;
        public double ElA;
        public double AzOld;
        public double ElOld;
        public Dictionary<DualFrameCacheKey, DualFrameResult> Cache;
    }
}
