using System;

namespace TreeExtractor
{
    /// <summary>
    /// 实验选项只在后端进程启动时读取一次，之后不可变，避免同一会话复用不同算法的缓存。
    /// 默认生产模式关闭；尚无人工真值标注时，实验结果只能用于离线核查。
    /// </summary>
    internal static class DualFrameExperimentOptions
    {
        internal const string EdgeCandidateVariable = "TREEEXTRACT_EXPERIMENT_EDGE_CANDIDATE";
        internal static readonly bool EdgeCandidateEnabled;

        static DualFrameExperimentOptions()
        {
            EdgeCandidateEnabled = IsExplicitlyEnabled(Environment.GetEnvironmentVariable(EdgeCandidateVariable));
        }

        // 仅接受确切的 1，避免 true、空白或其他意外值悄然改变生产算法。
        internal static bool IsExplicitlyEnabled(string value)
        {
            return string.Equals(value, "1", StringComparison.Ordinal);
        }

        // 显式调用会触发静态构造函数，确保 JSON 请求处理之前就捕获启动环境。
        internal static void CaptureAtStartup() { }
    }
}
