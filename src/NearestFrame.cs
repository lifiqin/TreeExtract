using System;
using System.Collections.Generic;

namespace TreeExtractor
{
    /// <summary>在存在全景帧和有效平面位姿的相机中，按水平距离寻找最近帧。</summary>
    internal static class NearestFrame
    {
        internal static bool TryFind(IList<FrameInfo> frames, IDictionary<string, double[]> poses,
                                     double treeX, double treeY, out int index, out double distance)
        {
            index = -1;
            distance = 0.0;
            if (frames == null || poses == null || !Finite(treeX) || !Finite(treeY)) return false;
            double bestSquared = double.PositiveInfinity;
            for (int i = 0; i < frames.Count; i++)
            {
                FrameInfo frame = frames[i];
                double[] pose;
                if (frame == null || string.IsNullOrEmpty(frame.Name) ||
                    !poses.TryGetValue(frame.Name, out pose) || !CameraPose.IsValid(pose)) continue;
                double dx = treeX - pose[0], dy = treeY - pose[1];
                double squared = dx * dx + dy * dy;
                // 距离相等时保留帧列表中的第一帧，确保结果稳定。
                if (!Finite(squared) || squared >= bestSquared) continue;
                bestSquared = squared;
                index = i;
            }
            if (index < 0) return false;
            distance = Math.Sqrt(bestSquared);
            return true;
        }

        static bool Finite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }
    }
}
