using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;

namespace TreeExtractor
{
    // 图像、视角、校正和本地识别适配。
    public partial class BackendSession
    {
        // 拖动时只编码全景，避免每一帧重复编码照片、切图和热力图。
        object DesktopPanoramaImage(Dictionary<string, object> args)
        {
            object value;
            bool preview = args.TryGetValue("preview", out value) && value is bool && (bool)value;
            using (Bitmap pano = _pano.RenderSnapshot(preview ? 640 : 960, preview ? 400 : 600))
                return new Dictionary<string, object> { { "panorama", DesktopImage(pano) } };
        }

        // 一次串行快照绑定树、帧、干净切图和本地结果，禁止跨树拼接。
        object DesktopRecognitionSnapshot()
        {
            if (_utmForest == null || _selUtmTree < 0 || _selUtmTree >= _utmForest.Trees.Count || _cropClean == null)
                throw new InvalidOperationException("请先选择树木并生成干净切图。");
            string image = DesktopImage(_cropClean);
            byte[] bytes = Convert.FromBase64String(image.Substring(image.IndexOf(',') + 1));
            string digest;
            using (var sha = SHA256.Create())
                digest = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            return new Dictionary<string, object> {
                { "dataDir", AppPaths.Root }, { "datasetFingerprint", DesktopSpeciesDatasetFingerprint() },
                { "treeId", _utmForest.Trees[_selUtmTree].Id },
                { "treeIndex", _selUtmTree + 1 }, { "frame", _curName ?? "" },
                { "image", image }, { "imageSha256", digest }, { "localText", _recognition ?? "" },
                { "peopleDetection", DescribePersonHeadDetection(_cropPersonHeadDetection) }
            };
        }

        object DesktopImages()
        {
            using (Bitmap pano = _pano.RenderSnapshot(960, 600))
            {
                return new Dictionary<string, object> {
                    { "panorama", DesktopImage(pano) },
                    { "photo", DesktopImage(_photo) },
                    { "photoPeopleDetection", PersonHeadDetectionSnapshot() },
                    { "crop", DesktopImage(_crop) },
                    { "cropPeopleDetection", DescribePersonHeadDetection(_cropPersonHeadDetection) },
                    { "heat", DesktopImage(_heat) }
                };
            }
        }

        // QA 必须在同一串行请求中获取照片和坐标，不能跨帧拼接状态。
        // 干净图不烤红圈或树号，供人工盲标；带标记图只用于对比。
        object DesktopPhotoSnapshot()
        {
            UtmTree tree = _utmForest != null && _selUtmTree >= 0 && _selUtmTree < _utmForest.Trees.Count
                ? _utmForest.Trees[_selUtmTree] : null;
            int frameIndex = _frames == null ? -1 : _frames.Frames.FindIndex(f =>
                string.Equals(f.Name, _curName, StringComparison.OrdinalIgnoreCase));
            bool hasPhoto = _photo != null && _recogClean != null &&
                _photo.Width == _recogClean.Width && _photo.Height == _recogClean.Height;
            return new Dictionary<string, object> {
                { "treeId", tree == null ? 0 : tree.Id },
                { "treeIndex", tree == null ? 0 : _selUtmTree + 1 },
                { "frame", _curName ?? "" }, { "frameIndex", frameIndex + 1 },
                { "photoClean", hasPhoto ? DesktopImage(_recogClean) : null },
                { "photoMarked", hasPhoto ? DesktopImage(_photo) : null },
                { "width", hasPhoto ? (object)_photo.Width : null },
                { "height", hasPhoto ? (object)_photo.Height : null },
                { "photoMarkNormalized", hasPhoto ? DesktopPhotoMarkNormalized() : null },
                { "dualFrameInfo", DesktopDualFrameInfo(tree) },
                { "peopleDetection", PersonHeadDetectionSnapshot() },
                { "photoRisk", new Dictionary<string, object> {
                    { "state", _photoRiskState }, { "reason", _photoRiskReason }
                } }
            };
        }

        // 相对于当前 4:3 图片左上角，不钳制越界坐标，避免把画外标记伪装成画内。
        object DesktopPhotoMarkNormalized()
        {
            if (_photo == null || !_markHasSpan ||
                double.IsNaN(_markFracTrunkX) || double.IsInfinity(_markFracTrunkX) ||
                double.IsNaN(_markFracTrunk) || double.IsInfinity(_markFracTrunk)) return null;
            return new Dictionary<string, object> {
                { "x", _markFracTrunkX }, { "y", _markFracTrunk },
                { "inFrame", _markFracTrunkX >= 0 && _markFracTrunkX <= 1 &&
                             _markFracTrunk >= 0 && _markFracTrunk <= 1 }
            };
        }

        static string DesktopImage(Image image)
        {
            if (image == null) return null;
            using (var stream = new MemoryStream())
            {
                image.Save(stream, ImageFormat.Jpeg);
                return "data:image/jpeg;base64," + Convert.ToBase64String(stream.ToArray());
            }
        }

        object DesktopOptions(Dictionary<string, object> args)
        {
            bool wasDual = _dualFrameEnabled, wasLowDistortion = _lowDistortion;
            bool wasLevelView = _levelView;
            SetChecked(args, "autoFrame", ref _autoFrame);
            SetChecked(args, "dualFrame", ref _dualFrameEnabled);
            if (wasDual != _dualFrameEnabled) ClearDualFrameCache();
            SetChecked(args, "levelView", ref _levelView);
            // 双帧候选的实际画幅及风险评估依赖水平取景，旧结果不能跨模式复用。
            if (wasLevelView != _levelView) InvalidateDualFrame(-1, true);
            SetChecked(args, "lowDistortion", ref _lowDistortion);
            if (wasLowDistortion != _lowDistortion)
            {
                Proj.NaturalD = _lowDistortion ? Proj.LowDistortionD : Proj.LegacyD;
                _refinedChoices.Clear();
                InvalidateDualFrame(-1, true);
                _fitTree = -1;
                _fitGps = double.NaN;
            }
            SetChecked(args, "lockView", ref _lockView);
            if (args.ContainsKey("frameStrategy"))
            {
                string strategy = StringArg(args, "frameStrategy");
                if (strategy != "quality" && strategy != "nearest")
                    throw new ArgumentException("不支持的选帧策略。 ");
                bool strict = strategy == "nearest";
                if (_strictNearestFrame != strict)
                {
                    _strictNearestFrame = strict;
                    _refinedChoices.Clear();
                    InvalidateDualFrame(-1, true);
                }
                // 显式选择策略即恢复自动选帧，否则手动帧会掩盖策略效果。
                _autoFrame = true;
            }
            SetNumeric(args, "cal", ref _cal, -180m, 180m);
            SetNumeric(args, "calV", ref _calV, -90m, 90m);
            SetNumeric(args, "cropWidth", ref _cropWidth, 1m, 120m);
            SetNumeric(args, "cropHeight", ref _cropHeight, 1m, 180m);
            if (args.ContainsKey("bearing") || args.ContainsKey("distance") || args.ContainsKey("elevation"))
            {
                _autoFrame = false;
                SetNumeric(args, "bearing", ref _bearing, 0m, 360m);
                SetNumeric(args, "distance", ref _distance, 0m, 1000m);
                SetNumeric(args, "elevation", ref _elevation, -90m, 90m);
                // 双帧可见中点按 4:3 画幅计算；手动改变取景后必须重新验证。
                InvalidateDualFrame(-1, true);
            }
            if (args.ContainsKey("viewPan") || args.ContainsKey("viewTilt"))
            {
                _lockView = false;
                SetNumeric(args, "viewPan", ref _viewPan, 0m, 360m);
                SetNumeric(args, "viewTilt", ref _viewTilt, -89m, 89m);
            }
            if (args.ContainsKey("viewFov"))
                _previewFov = Geo.Clamp(DoubleArg(args, "viewFov", _previewFov), 20, 140);
            SafeRecompute();
            DesktopClearRecognition();
            return DesktopState();
        }

        object DesktopPan(Dictionary<string, object> args)
        {
            if (_curFrame == null) throw new InvalidOperationException("请先加载全景数据。");
            double pan = Geo.Wrap360((double)_viewPan + DoubleArg(args, "panDelta", 0));
            double tilt = Geo.Clamp((double)_viewTilt + DoubleArg(args, "tiltDelta", 0), -89, 89);
            _previewFov = Geo.Clamp(DoubleArg(args, "fov", _previewFov), 20, 140);
            _lockView = false;
            _viewPan = (decimal)pan;
            _viewTilt = (decimal)tilt;
            PushPanoTarget();
            return DesktopState();
        }

        object DesktopSetMark(Dictionary<string, object> args)
        {
            if (!_markHasSpan || _selUtmTree < 0) throw new InvalidOperationException("当前帧没有可调整的树干标注。");
            double x = DoubleArg(args, "x", -1);
            double y = DoubleArg(args, "y", -1);
            if (x < 0 || x > 1 || y < 0 || y > 1) throw new ArgumentOutOfRangeException("坐标必须位于照片内。");
            double az, el;
            Proj.WorldFromPixelNatural(2 * x - 1, 1 - 2 * y, _photoBearing, _photoElev,
                                       _photoHf, _photoVf, _photoShift, out az, out el);
            SetManualMark(az, el);
            RefreshCrop();
            DesktopClearRecognition();
            return DesktopState();
        }

        object DesktopSetPanoMark(Dictionary<string, object> args)
        {
            if (!_markHasSpan || _selUtmTree < 0) throw new InvalidOperationException("当前帧没有可调整的树干标注。");
            double x = DoubleArg(args, "x", -1);
            double y = DoubleArg(args, "y", -1);
            if (x < 0 || x > 1 || y < 0 || y > 1) throw new ArgumentOutOfRangeException("坐标必须位于全景预览内。");
            double pan, tilt;
            Proj.WorldFromPixel(2 * x - 1, 1 - 2 * y, (double)_viewPan, (double)_viewTilt,
                                _previewFov, _previewFov * 600.0 / 960.0, out pan, out tilt);
            UnlockView();
            SetManualMark(Geo.Wrap360(pan + _curPanoRef + (double)_cal), tilt - (double)_calV);
            RefreshCrop();
            DesktopClearRecognition();
            return DesktopState();
        }

        void DesktopClearRecognition()
        {
            _recognition = "";
            ClearHeat("切图已更新，请重新识别。");
        }

        object DesktopSaveMark()
        {
            bool saved = SaveManualMarks();
            if (!saved && _markDirty) throw new IOException("人工校正保存失败。");
            return DesktopState();
        }

        object DesktopRecognize()
        {
            using (Bitmap source = GetRecogSource())
            {
                if (source == null) throw new InvalidOperationException("请先选择一棵树，生成切图后再识别。");
                TreeClassifier.Result result = TreeClassifier.Predict(source);
                if (result == null) throw new InvalidOperationException("本地模型未返回识别结果。");
                _recognition = result.Text;
                _heatTreeNo = _markTreeNo;
                _heatTitle = "识别注意力热力图 · " + result.Name;
                Bitmap heat = TreeClassifier.Heatmap(source, result.Index, null, delegate { return false; });
                SetHeat(heat, heat == null ? "未生成热力图" : null);
                return new Dictionary<string, object> {
                    { "name", result.Name }, { "probability", result.Prob }, { "reliable", result.Reliable },
                    { "text", result.Text }, { "topNames", result.TopNames }, { "topProbs", result.TopProbs }
                };
            }
        }

    }
}
