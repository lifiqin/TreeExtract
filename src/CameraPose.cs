namespace TreeExtractor
{
    // Metashape 位置与姿态的统一边界：[X,Y,Z,Omega,Phi,Kappa]。
    // 只要求前六项有限；保留已有读取器对尾随扩展字段的兼容行为。
    internal static class CameraPose
    {
        internal const int ComponentCount = 6;

        internal static bool IsValid(double[] pose)
        {
            if (pose == null || pose.Length < ComponentCount) return false;
            for (int i = 0; i < ComponentCount; i++)
                if (!double.IsFinite(pose[i])) return false;
            return true;
        }
    }
}
