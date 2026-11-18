using System;
using System.IO;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        // 以当前帧的相机中心找树，不得先把每棵树切到各自的最优帧。
        // 保持这一帧并退出自动选帧，避免 Recompute 把用户带到另一张照片。
        void SelectNearestTreeInCurrentFrame()
        {
            if (_frames == null || _utmForest == null || _curFrame == null || string.IsNullOrEmpty(_curName))
            {
                _status = "请先加载全景和树心数据，再定位当前帧最近树。";
                return;
            }

            string currentName = Path.GetFileName(_curName);
            int frameIndex = _frames.Frames.FindIndex(f =>
                string.Equals(f.Name, currentName, StringComparison.OrdinalIgnoreCase));
            double[] camera;
            if (frameIndex < 0 || !TryGetSelectionPose(frameIndex, out camera))
            {
                _status = "当前帧缺少完整相机位姿，无法可靠计算最近树。";
                return;
            }
            NearestTree.Result nearest;
            if (!NearestTree.TryFind(_utmForest.Trees, _trunkXy, camera[0], camera[1], out nearest))
            {
                _status = "当前帧或树心坐标无效，无法计算最近树。";
                return;
            }

            _manualFrameIdx = frameIndex;
            _autoFrame = false;
            LocateUtmTree(nearest.Index);
            string locationStatus = _status;
            _status = "当前帧最近树：序号 " + (nearest.Index + 1) + "，ID " + nearest.TreeId
                + "，水平距离 " + nearest.DistanceM.ToString("F2") + " m"
                + (nearest.UsedTrunkAxis ? "（树干轴心" : "（树心坐标")
                + "；保持当前帧，不判断遮挡）";
            if (nearest.DistanceM < 0.25)
                _status += "；距离过近，请核对坐标";
            if (!_markHasSpan)
            {
                // 水平距离为零、读图失败等情况不能覆盖 Recompute 的定位失败原因。
                _status += "；" + locationStatus;
                return;
            }
            if (_photoRiskState == "prior-overlap")
                _status += "；画面可能包含拍摄者，可开启自动选帧";
            if (_personHeadDetection == null || _personHeadDetection.Status == PersonHeadDetectionStatus.Unavailable)
                _status += "；人像检测不可用，请人工核查";
            else if (_photoRiskState == "detected")
                _status += "；本地模型检出疑似人体或头部，请人工核查";
        }
    }
}
