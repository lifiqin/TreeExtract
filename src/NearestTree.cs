using System;
using System.Collections.Generic;

namespace TreeExtractor
{
    /// <summary>当前帧相机位置到树干的水平最近邻；不把空间最近等同于图像可见。</summary>
    internal static class NearestTree
    {
        internal struct Result
        {
            public int Index;
            public int TreeId;
            public double DistanceM;
            public bool UsedTrunkAxis;
        }

        static bool Finite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        internal static bool TryFind(IList<UtmTree> trees, IDictionary<int, double[]> trunkAxes,
                                     double cameraX, double cameraY, out Result result)
        {
            result = new Result { Index = -1 };
            if (trees == null || !Finite(cameraX) || !Finite(cameraY)) return false;

            double bestSquared = double.PositiveInfinity;
            for (int i = 0; i < trees.Count; i++)
            {
                UtmTree tree = trees[i];
                if (tree == null || !Finite(tree.X) || !Finite(tree.Y) ||
                    !Finite(tree.Z) || !Finite(tree.Height) || tree.Height <= 0.0) continue;

                double x = tree.X, y = tree.Y;
                double[] axis = null;
                bool hasAxis = trunkAxes != null && trunkAxes.TryGetValue(tree.Id, out axis)
                    && axis != null && axis.Length >= 2 && Finite(axis[0]) && Finite(axis[1]);
                if (hasAxis) { x = axis[0]; y = axis[1]; }
                double dx = x - cameraX, dy = y - cameraY;
                double squared = dx * dx + dy * dy;
                if (!Finite(squared) || squared >= bestSquared) continue;
                bestSquared = squared;
                result = new Result { Index = i, TreeId = tree.Id, UsedTrunkAxis = hasAxis };
            }
            if (result.Index < 0) return false;
            result.DistanceM = Math.Sqrt(bestSquared);
            return true;
        }
    }
}
