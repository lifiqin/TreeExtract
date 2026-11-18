using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        void LoadUtmData(PreparedDataset prepared)
        {
            BackendLog.Write("LoadUtmData 开始");
            string treePath = prepared.TreePath;
            _refinedChoices.Clear();   // 树心/姿态数据可能换了，精细选帧缓存必须作废
            _frameReservations.Clear();
            _nearbyAxes.Clear();
            ClearDualFrameCache();     // 双帧交会缓存跟着数据集走，避免跨数据集串味
            _dataSetId = DataSetIdOf(treePath);

            // 所有输入都由 DatasetLoader 事先读取，提交阶段不重新解析。
            var forest = prepared.Forest;
            _utmForest = forest;

            // 手动校正跟着树心数据集走：文件放在树心同目录，选中树时按树号自动叠加。
            // 有未保存的拖动结果时不覆盖内存（重新点「加载树心」不该丢掉刚调好的位置）。
            SetMarkStorePath(treePath);
            if (!_markDirty) ApplyManualMarks(prepared.Marks);

            // 加载 Metashape 姿态（帧名 → UTM XYZ + OPK）；解析逻辑与「树心-全景对照表」共用同一份
            var meta = prepared.Metadata;
            _metaPose = meta;

            // 点云实测树冠半径（每棵树的树冠水平半径，离线从 objectsegment.ply 量出）。
            _crownR = prepared.Crown;

            // 点云实测树干轴心（离线从 objectsegment.ply 量出）：红圈要对准树干，
            // 必须按树干轴心算方位——树心坐标是树冠重心，与干心差 0.04~0.43m。
            _trunkXy = prepared.Trunk;

            // 数据就绪
            _selUtmTree = -1;
            _status = "已加载 " + forest.Trees.Count + " 棵树心 / Metashape " + meta.Count + " 帧。";
            BackendLog.Write("LoadUtmData 完成 树=" + forest.Trees.Count + " meta=" + meta.Count);

            // 自动选中一棵「明显」的树并定位。DEF-06：手动点「加载树心+Metashape」
            // 重载时也锁住双帧旁路（保存/恢复原状态，兼容 AutoLoadAll 的外层 guard）。
            bool prevGuard = _startupGuard;
            _startupGuard = true;
            try { AutoSelectStartupTree(forest); }
            finally { _startupGuard = prevGuard; }
        }

        // 启动时自动选中一棵「明显」的树并定位：否则启动后一棵树都没选中，
        // 全景红十字和「最近照片」红圈只能用默认方位(100°)去标。
        // 不能简单选第1棵——树1只有2.3m高，被1~2m草丛挡住，红十字落在草上像标错；
        // 改为按「高度/距离」选又高又近的树，启动时红叉直接落在浓密树冠上。
        void AutoSelectStartupTree(UtmForest forest)
        {
            if (forest.Trees.Count == 0 || _curName == null || _metaPose == null) return;
            int best = -1; double bestScore = -1, bD = 0, bAz = 0, bEl = 0;
            for (int i = 0; i < forest.Trees.Count; i++)
            {
                double d, az, el;
                PickFrameUtm(forest.Trees[i], out d, out az, out el);
                // 帧索引是成功标志；0 距离和正北方位都可能是合法结果。
                if (_manualFrameIdx < 0 || _manualFrameIdx >= _frames.Frames.Count ||
                    double.IsNaN(d) || double.IsInfinity(d) || d < 0) continue;
                double score = forest.Trees[i].Height / Math.Max(d, 4.0);
                if (score > bestScore) { bestScore = score; best = i; bD = d; bAz = az; bEl = el; }
            }
            if (best < 0)
            {
                // 仍保留数据集，交由自动选帧明确提示并清理旧画面。
                _selUtmTree = 0;
                SafeRecompute();
                return;
            }
            _selUtmTree = best;
            SetTreeTarget(bAz, bD, bEl);
            BackendLog.Write("自动选中树" + (best + 1) + " 高=" + forest.Trees[best].Height.ToString("F1")
                + " bearing=" + bAz.ToString("F2") + " dist=" + bD.ToString("F2")
                + " elev=" + bEl.ToString("F2") + " 对准角=" + _pickAng.ToString("F1") + "° 帧=" + (_manualFrameIdx >= 0 && _frames != null && _manualFrameIdx < _frames.Frames.Count
                    ? _frames.Frames[_manualFrameIdx].Name : "(无)"));
        }

        // 树号跳转：直接用 UTM 坐标算方位/距离/仰角并定位
        void LocateUtmTree(int idx)
        {
            if (_utmForest == null || idx < 0 || idx >= _utmForest.Trees.Count) return;
            _selUtmTree = idx;
            var t = _utmForest.Trees[idx];
            if (_metaPose == null || _curName == null) { _status = "请先加载全景数据"; return; }
            double[] mp;
            string frameName = Path.GetFileName(_curName);
            if (!_metaPose.TryGetValue(frameName, out mp) || !CameraPose.IsValid(mp))
            {
                // 固定帧缺位姿时不能悄悄换到其他照片，再冒充当前帧定位。
                _status = "当前帧缺少完整相机位姿，无法可靠定位该树；请选择有位姿的帧或开启自动选帧。";
                return;
            }
            double camX = mp[0], camY = mp[1], camZ = mp[2];
            double bearing, elev, dist;
            UtmForest.TreeAzim(AimTrunk(t), camX, camY, camZ, out bearing, out elev, out dist);
            SetTreeTarget(bearing, dist, elev);
        }

        void ShiftFrame(int dir)
        {
            if (_frames == null || _frames.Frames.Count == 0) return;
            // 找到当前帧在列表中的索引
            int idx = 0;
            for (int i = 0; i < _frames.Frames.Count; i++)
                if (_frames.Frames[i].Name == _curName) { idx = i; break; }
            idx = (idx + dir + _frames.Frames.Count) % _frames.Frames.Count;
            _manualFrameIdx = idx;
            _autoFrame = false;
            // 切换相机后，选中树相对相机的方向会变化，不能继续沿用上一帧的方向。
            double[] framePose;
            if (_utmForest != null && _selUtmTree >= 0 && _selUtmTree < _utmForest.Trees.Count &&
                TryGetSelectionPose(idx, out framePose))
            {
                double az, el, dist;
                UtmForest.TreeAzim(AimTrunk(_utmForest.Trees[_selUtmTree]), framePose[0], framePose[1],
                                   framePose[2], out az, out el, out dist);
                SetTargetInputs(az, dist, el);
            }
            SafeRecompute();
        }
        int _manualFrameIdx = -1;

        void LoadData(PreparedDataset prepared)
        {
            BackendLog.Write("LoadData 开始 zip=" + _zipPath.Trim());
            _status = "正在加载...";
            if (_frames != null) { _frames.Dispose(); _frames = null; }
            _frames = prepared.TakeFrames();
            BackendLog.Write("FrameStore 完成 帧=" + _frames.Frames.Count);
            BuildFlightSegments();   // DEF-04：帧列表就绪即重建架次段 ID
            _poses = prepared.Poses;
            BackendLog.Write("PoseIndex 完成 姿态=" + _poses.Poses.Count);

            _status = "已加载 " + _frames.Frames.Count + " 帧全景 / " + _poses.Poses.Count + " 条姿态";
            Recompute();
            BackendLog.Write("LoadData 完成");
        }
    }
}
