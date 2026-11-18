using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace TreeExtractor
{
    /// <summary>回放 CSV 中某棵树的当前结果。</summary>
    internal sealed class ReplayEntry
    {
        public int TreeId;
        public string Line;
    }

    internal static partial class DualFrameEngine
    {
        // 每个数据集与校正参数作用域内按树号覆盖，全量重写当前结果。
        static readonly object ReplayLock = new object();
        static readonly List<ReplayEntry> ReplayRows = new List<ReplayEntry>();
        static string _replayScope = null;
        static bool _replayCompleteLogged = false;

        const string ReplayHeader =
            "树号,A,B,基线角,残差,置信度,AzOld,ElOld,AzNew,ElNew,高度,限幅,状态,原因,"
            + "dAzA,dAzB,dElA,dElB,agree,w,诊断残差\r\n";

        static string ReplayPath()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                                DualFrameConfig.ReplayCsvRelative);
        }

        /// <summary>清空全部回放行并立即重写表头（LoadUtmData / 开关切换 / 数据集切换时调用）。</summary>
        internal static void ResetReplay()
        {
            try
            {
                string path = ReplayPath();
                lock (ReplayLock)
                {
                    ReplayRows.Clear();
                    _replayScope = null;
                    _replayCompleteLogged = false;
                    EnsureReplayDir(path);
                    FlushReplayFile(path);
                }
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 回放CSV重置失败: " + ex.Message);
            }
        }

        /// <summary>单树失效：只删该树的旧行（含旧 Status），立即全量重写，避免残留。</summary>
        internal static void InvalidateReplayTree(int treeId)
        {
            try
            {
                string path = ReplayPath();
                lock (ReplayLock)
                {
                    int removed = ReplayRows.RemoveAll(
                        delegate(ReplayEntry e) { return e.TreeId == treeId; });
                    if (removed > 0 && File.Exists(path)) FlushReplayFile(path);
                }
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 回放CSV单树失效失败: " + ex.Message);
            }
        }

        /// <summary>
        /// 写一次结果：同 (DataSetId,Cal) 作用域内按树号覆盖（状态变化即覆盖），
        /// 然后每次都全量重写 表头 + 当前所有树行，绝不残留旧状态、绝不只剩一行。
        /// </summary>
        internal static void WriteReplay(DualFrameResult r, int treeId, string dataSetId,
                                         double cal, double calV, int expectedTreeCount)
        {
            try
            {
                if (r == null) return;
                string path = ReplayPath();
                EnsureReplayDir(path);
                string scope = (dataSetId == null ? "unknown" : dataSetId) + "\u0001"
                             + cal.ToString("F5", CultureInfo.InvariantCulture) + "\u0001"
                             + calV.ToString("F5", CultureInfo.InvariantCulture);
                string line = BuildReplayLine(r, treeId);
                lock (ReplayLock)
                {
                    if (!string.Equals(_replayScope, scope, StringComparison.Ordinal))
                    {
                        _replayScope = scope;
                        ReplayRows.Clear();
                        _replayCompleteLogged = false;
                    }
                    ReplayRows.RemoveAll(delegate(ReplayEntry e) { return e.TreeId == treeId; });
                    ReplayRows.Add(new ReplayEntry { TreeId = treeId, Line = line });
                    FlushReplayFile(path);

                    if (expectedTreeCount > 0 && ReplayRows.Count == expectedTreeCount
                        && !_replayCompleteLogged)
                    {
                        _replayCompleteLogged = true;
                        BackendLog.Write("回放CSV 全量落盘 行数="
                            + ReplayRows.Count.ToString(CultureInfo.InvariantCulture)
                            + " 作用域=" + scope);
                    }
                }
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 回放CSV写入失败: " + ex.Message);
            }
        }

        static void EnsureReplayDir(string path)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
        }

        static void FlushReplayFile(string path)
        {
            var sb = new StringBuilder();
            sb.Append(ReplayHeader);
            foreach (ReplayEntry e in ReplayRows) sb.Append(e.Line);
            File.WriteAllText(path, sb.ToString(), new UTF8Encoding(true));
        }

        static string BuildReplayLine(DualFrameResult r, int treeId)
        {
            return string.Format(CultureInfo.InvariantCulture,
                "{0},{1},{2},{3:F2},{4:F3},{5:F3},{6:F3},{7:F3},{8:F3},{9:F3},{10:F3},{11},{12},{13},"
                + "{14:F3},{15:F3},{16:F3},{17:F3},{18:F4},{19:F4},{20:F3}\r\n",
                treeId,
                Csv(r.FrameA), Csv(r.FrameB),
                r.BaselineAngleDeg, r.ResidualM, r.Confidence,
                r.AzOld, r.ElOld, r.AzNew, r.ElNew, r.HeightM,
                r.LimitClamped ? 1 : 0, r.Status, r.Reason,
                r.Fusion.DAzA, r.Fusion.DAzB, r.Fusion.DElA, r.Fusion.DElB,
                r.Fusion.Agree, r.Fusion.WeightA, r.Fusion.ResidualM);
        }

        static string Csv(string s)
        {
            string v = string.IsNullOrEmpty(s) ? "-" : s;
            return v.Contains(",") ? "\"" + v.Replace("\"", "\"\"") + "\"" : v;
        }
    }
}
