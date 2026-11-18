using System;
using System.Collections.Generic;
using System.IO;

namespace TreeExtractor
{
    // 手动校正（拖动红十字准心）的持久化：写盘只在用户点「保存校正」时发生，
    // 启动加载树心数据时自动读回。文件与树心文件同目录（E:\树木识别\tree\manual_marks.csv），
    // 树心目录不可用时退到 exe 目录，保证换机器部署也能落盘。
    //
    // 存的是「相对自动树干锚点的角度偏移」而不是绝对方位：自动锚点逐帧重算，
    // 偏移量才能跨帧、跨启动继续有效（与 ApplyMarkOffset 的语义一致）。
    // 文本格式一行一棵树，便于人工核对与备份：
    //   # 注释行
    //   105,1.23500,-0.48000
    public partial class BackendSession
    {
        string _markStorePath;   // 校正文件路径（首次用时解析一次）
        bool _markDirty;         // 内存里的校正与文件不一致（拖动过或重置过但没保存）
        ManualMarkSnapshot _markSnapshot; // 读取时的文件版本；保存前用于检测外部修改。

        // 校正文件路径：优先树心数据目录，其次程序目录
        string MarkStorePath()
        {
            if (!string.IsNullOrEmpty(_markStorePath)) return _markStorePath;
            _markStorePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "manual_marks.csv");
            return _markStorePath;
        }

        // LoadUtmData 拿到树心文件真实路径后调用：校正与树心数据放一起，跟着数据集走
        void SetMarkStorePath(string treePath)
        {
            try
            {
                string dir = Path.GetDirectoryName(treePath);
                if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                    _markStorePath = Path.Combine(dir, "manual_marks.csv");
            }
            catch (Exception ex) { BackendLog.Write("校正文件路径解析失败: " + ex.Message); }
        }

        // 双帧交会的人工优先判据：只要该树有 manual_marks 记录就跳过双帧，
        // 使用旧 TrunkMarkH 锚点，保证历史 dAz/dEl 不漂移。
        bool HasManualMark(int treeId)
        {
            return _markManual != null && _markManual.ContainsKey(treeId);
        }

        // 数据准备阶段已完整解析文件；提交时只替换当前会话内存。
        void ApplyManualMarks(ManualMarkSnapshot snapshot)
        {
            string path = MarkStorePath();
            _markManual = snapshot.Entries;
            _markSnapshot = snapshot;
            _markDirty = false;
            BackendLog.Write("手动校正读取 " + _markManual.Count + " 棵 ← " + path);
            // 人工记录集合变了，双帧的人工优先判定必须重来（全部树一次失效）。
            InvalidateDualFrame(-1, true);
        }

        // 文件版本未变化时才允许原子替换，并保留旧内容作为备份。
        bool SaveManualMarks()
        {
            int n = _markManual == null ? 0 : _markManual.Count;
            if (n == 0 && !_markDirty)
            {
                _status = "暂无可保存的手动校正（还没拖动过，也没有已存记录）";
                return false;
            }
            string path = MarkStorePath();
            try
            {
                var result = ManualMarkRepository.Write(path, _markManual ?? new Dictionary<int, double[]>(), _markSnapshot);
                _markSnapshot = result.Snapshot;
                _markDirty = false;
                // 人工校正落盘：相关树的双帧结果作废，避免旧 Success 结果压过人工优先。
                InvalidateDualFrame(-1, true);
                BackendLog.Write("手动校正已保存 " + n + " 棵 → " + path);
                _status = "已保存 " + n + " 棵树的手动校正 → " + path +
                    (result.BackupPath == null ? "" : "；旧文件备份 → " + result.BackupPath);
                return true;
            }
            catch (UserFacingException) { throw; }
            catch (Exception ex)
            {
                BackendLog.Write("手动校正保存失败: " + ex.Message);
                throw new UserFacingException("无法确认手动校正是否保存，请检查文件和备份：" + path, ex);
            }
        }

    }
}
