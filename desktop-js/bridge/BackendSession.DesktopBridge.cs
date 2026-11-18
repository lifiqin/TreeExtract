using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        // 仅暴露明确操作及独立验收快照，不接收任意方法名或脚本。
        internal object DesktopDispatch(string method, Dictionary<string, object> args)
        {
            switch (method)
            {
                case "defaults": return DesktopDefaults();
                case "merge.archive": return DesktopMergeArchive(args);
                case "load": return DesktopLoad(args);
                case "state": return DesktopState();
                case "trees": return DesktopTrees();
                case "images": return DesktopImages();
                case "panorama.image": return DesktopPanoramaImage(args);
                case "recognition.snapshot": return DesktopRecognitionSnapshot();
                case "photo.snapshot": return DesktopPhotoSnapshot();
                case "dual.evidence": return DesktopDualEvidence();
                case "tree.select": return DesktopSelectTree(IntArg(args, "index"));
                case "tree.nearest": return DesktopNearestTree();
                case "frame.step": return DesktopStepFrame(IntArg(args, "direction"));
                case "view.options": return DesktopOptions(args);
                case "view.pan": return DesktopPan(args);
                case "mark.set": return DesktopSetMark(args);
                case "mark.setPano": return DesktopSetPanoMark(args);
                case "mark.reset":
                    ClearManualMark();
                    DesktopClearRecognition();
                    return DesktopState();
                case "mark.save": return DesktopSaveMark();
                case "crop.inspect": return DesktopInspectCrop();
                case "crop.save":
                    object confirmed;
                    return DesktopSaveCrop(StringArg(args, "path"), StringArg(args, "imageSha256"),
                        args.TryGetValue("reviewConfirmed", out confirmed) && confirmed is bool && (bool)confirmed);
                case "recognize": return DesktopRecognize();
                case "table.build": return DesktopBuildTable();
                case "table.select": return DesktopSelectTableRow(IntArg(args, "id"));
                case "table.export": return DesktopExportTable(StringArg(args, "path"), StringArg(args, "format"));
                default: throw new ArgumentException("不支持的操作：" + method);
            }
        }

        object DesktopDefaults()
        {
            return new Dictionary<string, object> {
                { "dataDir", AppPaths.Root }, { "zipPath", AppPaths.ZipPath },
                { "modelPath", TreeClassifier.ModelPath }
            };
        }

        object DesktopLoad(Dictionary<string, object> args)
        {
            if (_markDirty)
                throw new InvalidOperationException("当前有未保存的红圈校正，请先保存后再切换数据。");
            string requestedDir = StringArg(args, "dataDir");
            string requestedZip = StringArg(args, "zipPath");
            bool custom = !string.IsNullOrWhiteSpace(requestedDir) || !string.IsNullOrWhiteSpace(requestedZip);
            string root = string.IsNullOrWhiteSpace(requestedDir) ? AppPaths.Root : Path.GetFullPath(requestedDir);
            string zip = string.IsNullOrWhiteSpace(requestedZip)
                ? (custom ? Path.Combine(root, "Camera4.zip") : AppPaths.ZipPath)
                : Path.GetFullPath(requestedZip);
            string pose = custom ? Path.Combine(root, "imgPosList.txt") : AppPaths.PosePath;
            string tree = custom ? Path.Combine(root, "tree_centers2.txt") : AppPaths.TreePath;
            if (custom && !File.Exists(tree)) tree = Path.Combine(root, "tree_centers.txt");
            string meta = custom ? Path.Combine(root, "Metashape.txt") : AppPaths.MetaPath;
            string crown = custom ? Path.Combine(root, "crown.csv") : AppPaths.CrownPath;
            string trunk = custom ? Path.Combine(root, "trunk.csv") : AppPaths.TrunkPath;
            foreach (string path in new[] { zip, pose, tree, meta })
                if (!File.Exists(path)) throw new FileNotFoundException("缺少运行数据：" + path);
            // 先完整准备输入和 ZIP 句柄；准备失败时当前会话保持不变。
            using (var prepared = DatasetLoader.Prepare(zip, pose, tree, meta, crown, trunk))
            {
                if (custom) AppPaths.ConfigureSession(root, zip);
                // 换数据时，即使两套数据有同名帧，也不能沿用上一套的位图或树心。
                if (_pano != null) _pano.SetSource(null);
                _curFrame = null;
                _curName = "";
                _utmForest = null;
                _metaPose = null;
                _selUtmTree = -1;
                // 手动固定帧只属于旧数据集；新数据集必须重新为目标树选帧。
                _autoFrame = true;
                _manualFrameIdx = -1;
                _fitTree = -1;
                _fitGps = double.NaN;
                _desktopTableRows = null;
                _speciesDatasetFingerprint = null;
                _speciesSourceStamp = null;
                _speciesIdentityError = null;
                _zipPath = AppPaths.ZipPath;
                _posePath = AppPaths.PosePath;
                // 在读取会话数据之前绑定文件内容，避免第一次打开识别时才绑定到另一批数据。
                try { DesktopSpeciesDatasetFingerprint(); }
                catch { _speciesIdentityError = "无法绑定数据集身份，请检查文件并重新加载。"; }
                LoadData(prepared);
                LoadUtmData(prepared);
                if (_utmForest == null || _frames == null)
                    throw new InvalidOperationException("数据加载失败，请检查文件内容。");
                if (string.IsNullOrEmpty(_speciesIdentityError))
                {
                    try { DesktopSpeciesDatasetFingerprint(); }
                    catch { _speciesIdentityError = "加载期间数据文件发生变化，请重新加载。"; }
                }
                DesktopClearRecognition();
                return DesktopState();
            }
        }

        object DesktopState()
        {
            UtmTree tree = _utmForest != null && _selUtmTree >= 0 && _selUtmTree < _utmForest.Trees.Count
                ? _utmForest.Trees[_selUtmTree] : null;
            int frameIndex = _frames == null ? -1 : _frames.Frames.FindIndex(f =>
                string.Equals(f.Name, _curName, StringComparison.OrdinalIgnoreCase));
            double[] framePose;
            bool framePoseAvailable = TryGetSelectionPose(frameIndex, out framePose);
            bool distanceUsesTrunk;
            object horizontalDistance = DesktopHorizontalDistance(tree,
                framePoseAvailable ? framePose : null, out distanceUsesTrunk);
            string selectionWarning = _autoFrame && frameIndex < 0 &&
                !string.IsNullOrEmpty(_frameSelectionFailure) && _status == _frameSelectionFailure
                ? _frameSelectionFailure : "";
            if (tree != null && framePoseAvailable && frameIndex >= 0)
            {
                int? owner = _frameReservations.OtherOwner(frameIndex, tree.Id);
                FrameSeparation.Conflict conflict = NeighborConflict(tree, framePose);
                if (owner.HasValue)
                    selectionWarning = "当前帧已用于树 " + owner.Value + "；使用相同帧不能证明两棵树可区分，请切换优质近帧或手动换视角核查。";
                if (conflict != null)
                    selectionWarning += (selectionWarning.Length > 0 ? " " : "") +
                        "与邻树 " + conflict.TreeId + " 的方向接近，可能遮挡或误认；请切换视角人工核查。";
                if (HasManualMark(tree.Id))
                    selectionWarning += (selectionWarning.Length > 0 ? " " : "") +
                        "该树使用已有人工校正；切换视角后请核查红圈，未确认前不要覆盖。";
            }
            return new Dictionary<string, object> {
                { "loaded", _utmForest != null && _frames != null },
                { "dataDir", AppPaths.Root }, { "zipPath", AppPaths.ZipPath },
                { "treeCount", _utmForest == null ? 0 : _utmForest.Trees.Count },
                { "treeIndex", tree == null ? 0 : _selUtmTree + 1 },
                { "treeId", tree == null ? 0 : tree.Id },
                { "treeSpecies", tree == null ? "" : tree.Species },
                { "treeHeight", tree == null ? 0.0 : tree.Height },
                { "frame", _curName ?? "" }, { "frameIndex", frameIndex + 1 },
                { "frameCount", _frames == null ? 0 : _frames.Frames.Count },
                { "framePoseAvailable", framePoseAvailable },
                { "frameSelectionWarning", selectionWarning },
                { "targetValid", tree != null && framePoseAvailable && _markHasSpan },
                { "photoRisk", new Dictionary<string, object> {
                    { "state", _photoRiskState }, { "reason", _photoRiskReason }
                } },
                { "cameraHorizontalDistance", horizontalDistance },
                { "distanceUsesTrunkAxis", horizontalDistance == null ? null : (object)distanceUsesTrunk },
                { "bearing", (double)_bearing }, { "distance", (double)_distance },
                { "elevation", (double)_elevation }, { "viewPan", (double)_viewPan },
                { "viewTilt", (double)_viewTilt }, { "viewFov", _previewFov },
                { "cal", (double)_cal }, { "calV", (double)_calV },
                { "cropWidth", (double)_cropWidth }, { "cropHeight", (double)_cropHeight },
                { "autoFrame", _autoFrame }, { "dualFrame", _dualFrameEnabled },
                { "frameStrategy", _strictNearestFrame ? "nearest" : "quality" },
                { "levelView", _levelView }, { "lowDistortion", _lowDistortion },
                { "lockView", _lockView }, { "markDirty", _markDirty },
                { "markMode", _markMode },
                { "markAz", _markHasSpan ? DesktopFiniteNumber(_markAzTrunk) : null },
                { "markEl", _markHasSpan ? DesktopFiniteNumber(_markElTrunk) : null },
                { "photoMarkNormalized", DesktopPhotoMarkNormalized() },
                { "dualFrameInfo", DesktopDualFrameInfo(tree) },
                { "status", _status },
                { "recognition", _recognition },
                { "heatTitle", _heatTitle }
            };
        }

        // 当前帧的实测相机坐标与树干轴心水平距离；缺少轴心时退回树心，缺位姿则不猜测。
        object DesktopHorizontalDistance(UtmTree tree, double[] camera, out bool usesTrunkAxis)
        {
            usesTrunkAxis = false;
            if (tree == null || camera == null) return null;
            double treeX, treeY;
            usesTrunkAxis = TrunkAxisUtm(tree, out treeX, out treeY);
            return DesktopFiniteNumber(Geo.Dist2D(treeX - camera[0], treeY - camera[1]));
        }

        // 勾选开关不代表双帧已经执行：只展示当前树和当前帧对应的真实结果。
        Dictionary<string, object> DesktopDualFrameInfo(UtmTree tree)
        {
            var info = new Dictionary<string, object> {
                { "state", "unavailable" }, { "reason", "请选择有姿态的树木和照片" },
                { "frameA", "" }, { "frameB", "" },
                { "confidence", null }, { "baselineAngle", null }, { "attempts", null }, { "limited", false },
                { "attemptDetails", new List<object>() }
            };
            if (tree == null || _curFrame == null || !_markHasSpan) return info;
            info["frameA"] = _curName ?? "";

            if (HasManualMark(tree.Id))
            {
                info["state"] = "manual";
                info["reason"] = "重置为自动后可尝试双帧定位";
                return info;
            }
            if (!_dualFrameEnabled)
            {
                info["state"] = "disabled";
                info["reason"] = "打开双帧定位后可尝试分析";
                return info;
            }
            DualFrameResult result = _dualFrameCur;
            if (result == null || !string.Equals(result.FrameA, _curName, StringComparison.OrdinalIgnoreCase))
            {
                info["state"] = "not_run";
                info["reason"] = "当前照片尚未执行双帧分析";
                return info;
            }

            if (result.Status == DualFrameStatus.Disabled)
            {
                info["state"] = "disabled";
                info["reason"] = "双帧定位已关闭";
                return info;
            }
            if (result.Status == DualFrameStatus.ManualSkipped)
            {
                info["state"] = "manual";
                info["reason"] = "人工校正优先生效，双帧定位已跳过";
                return info;
            }

            info["frameA"] = result.FrameA ?? "";
            info["frameB"] = result.FrameB ?? "";
            info["limited"] = result.LimitClamped;
            info["attempts"] = Math.Max(0, result.PairAttempts);
            var attemptDetails = new List<object>();
            if (result.Attempts != null)
            {
                foreach (DualFrameAttemptDiagnostics attempt in result.Attempts)
                {
                    if (attempt == null) continue;
                    string reason = attempt.Reason == FallbackReason.None
                        ? "通过内部验证，仍需目视复核"
                        : new DualFrameResult { Reason = attempt.Reason }.ReasonText;
                    attemptDetails.Add(new Dictionary<string, object> {
                        { "frameB", attempt.FrameB ?? "" },
                        { "primaryCandidates", attempt.PrimaryCandidates },
                        { "secondaryCandidates", attempt.SecondaryCandidates },
                        { "reason", reason },
                        { "axisErrorM", DesktopFiniteNumber(attempt.AxisErrorM) },
                        { "axisLimitM", DesktopFiniteNumber(attempt.AxisLimitM) },
                        { "appearanceCorrelation", DesktopFiniteNumber(attempt.AppearanceCorrelation) },
                        { "appearanceStatus", attempt.AppearanceStatus ?? "not_attempted" }
                    });
                }
            }
            info["attemptDetails"] = attemptDetails;
            if (!string.IsNullOrEmpty(result.FrameB))
                info["baselineAngle"] = DesktopFiniteNumber(result.BaselineAngleDeg);
            if (result.Status == DualFrameStatus.Success)
            {
                info["state"] = "success";
                info["reason"] = "候选段通过几何与纹理检查；目标身份仍需目视复核";
                info["confidence"] = DesktopFiniteNumber(result.Confidence);
            }
            else
            {
                info["state"] = "fallback";
                info["reason"] = result.ReasonText + "；红圈为估计值，请手动核验";
                if (result.Reason == FallbackReason.LowConfidence || result.Reason == FallbackReason.LimitExceeded)
                    info["confidence"] = DesktopFiniteNumber(result.Confidence);
            }
            return info;
        }

        static object DesktopFiniteNumber(double number)
        {
            return double.IsNaN(number) || double.IsInfinity(number) ? null : (object)number;
        }

        object DesktopTrees()
        {
            var list = new List<object>();
            if (_utmForest == null) return list;
            for (int i = 0; i < _utmForest.Trees.Count; i++)
            {
                UtmTree t = _utmForest.Trees[i];
                list.Add(new Dictionary<string, object> {
                    { "index", i + 1 }, { "id", t.Id }, { "height", t.Height }, { "species", t.Species }
                });
            }
            return list;
        }

        object DesktopSelectTree(int index)
        {
            if (_utmForest == null || index < 1 || index > _utmForest.Trees.Count)
                throw new ArgumentOutOfRangeException("index", "树序号超出范围。");
            int targetIndex = index - 1;
            if (targetIndex != _selUtmTree)
            {
                // 固定当前帧只对当前树生效；切换树后重新按所选策略找相机。
                // 不依赖旧帧的位姿，避免缺位姿或跨数据集时沿用错误方向。
                _selUtmTree = targetIndex;
                _autoFrame = true;
                SafeRecompute();
            }
            // 重选同一棵时不改变当前帧，尤其不能在缺位姿时静默跳到别帧。
            DesktopClearRecognition();
            return DesktopState();
        }

        object DesktopNearestTree()
        {
            SelectNearestTreeInCurrentFrame();
            DesktopClearRecognition();
            return DesktopState();
        }

        object DesktopStepFrame(int direction)
        {
            ShiftFrame(direction < 0 ? -1 : 1);
            DesktopClearRecognition();
            return DesktopState();
        }

        static string StringArg(Dictionary<string, object> args, string key)
        {
            object value;
            return args.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }
        static int IntArg(Dictionary<string, object> args, string key)
        {
            object value;
            if (!args.TryGetValue(key, out value)) throw new ArgumentException("缺少参数：" + key);
            return Convert.ToInt32(value, CultureInfo.InvariantCulture);
        }
        static double DoubleArg(Dictionary<string, object> args, string key, double fallback)
        {
            object value;
            if (!args.TryGetValue(key, out value) || value == null) return fallback;
            double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (double.IsNaN(number) || double.IsInfinity(number))
                throw new ArgumentException("参数必须是有效数字：" + key);
            return number;
        }
        static void SetChecked(Dictionary<string, object> args, string key, ref bool setting)
        {
            object value;
            if (args.TryGetValue(key, out value)) setting = Convert.ToBoolean(value);
        }

        static void SetNumeric(Dictionary<string, object> args, string key, ref decimal setting,
                               decimal minimum, decimal maximum)
        {
            if (!args.ContainsKey(key)) return;
            double value = DoubleArg(args, key, 0);
            if (value < (double)minimum || value > (double)maximum)
                throw new ArgumentOutOfRangeException(key, "数值超出允许范围。");
            setting = (decimal)value;
        }
    }
}
