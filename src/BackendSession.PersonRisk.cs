using System;
using System.Collections.Generic;
using System.Drawing;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        PersonHeadDetector _personHeadDetector;
        PersonHeadDetection _personHeadDetection = PersonHeadDetection.Unavailable("照片尚未生成");
        Bitmap _personHeadCacheFrame;
        double[] _personHeadCacheGeometry;
        PersonHeadDetection _cropPersonHeadDetection = PersonHeadDetection.Unavailable("切图尚未生成");
        Bitmap _cropHeadCacheFrame;
        double[] _cropHeadCacheGeometry;

        // The result belongs to the clean 4:3 photo: changing the source or projection invalidates it.
        void UpdatePersonHeadDetection(Bitmap photo, double cal, double calV)
        {
            if (photo == null || _curFrame == null)
            {
                ClearPersonHeadDetection();
                return;
            }
            double[] geometry = {
                _photoBearing, _photoElev, _photoHf, _photoVf, _photoShift,
                _curPanoRef, cal, calV, Proj.NaturalD
            };
            bool cacheHit = ReferenceEquals(_personHeadCacheFrame, _curFrame) && _personHeadCacheGeometry != null;
            if (cacheHit)
            {
                for (int i = 0; i < geometry.Length; i++)
                    if (geometry[i] != _personHeadCacheGeometry[i]) { cacheHit = false; break; }
            }
            if (cacheHit) return;

            if (_personHeadDetector == null) _personHeadDetector = new PersonHeadDetector();
            _personHeadDetection = _personHeadDetector.Detect(photo);
            _personHeadCacheFrame = _curFrame;
            _personHeadCacheGeometry = geometry;
        }

        void ClearPersonHeadDetection()
        {
            _personHeadCacheFrame = null;
            _personHeadCacheGeometry = null;
            _personHeadDetection = PersonHeadDetection.Unavailable("当前照片不可用");
            _cropHeadCacheFrame = null;
            _cropHeadCacheGeometry = null;
            _cropPersonHeadDetection = PersonHeadDetection.Unavailable("当前切图不可用");
        }

        void UpdateCropPersonHeadDetection(Bitmap crop, double azimuth, double elevation,
                                           double horizontalFov, double verticalFov, double cal, double calV)
        {
            if (crop == null || _curFrame == null)
            {
                _cropHeadCacheFrame = null;
                _cropHeadCacheGeometry = null;
                _cropPersonHeadDetection = PersonHeadDetection.Unavailable("当前切图不可用");
                return;
            }
            double[] geometry = { azimuth, elevation, horizontalFov, verticalFov, _curPanoRef, cal, calV, Proj.NaturalD };
            bool hit = ReferenceEquals(_cropHeadCacheFrame, _curFrame) && _cropHeadCacheGeometry != null;
            if (hit)
            {
                for (int i = 0; i < geometry.Length; i++)
                    if (geometry[i] != _cropHeadCacheGeometry[i]) { hit = false; break; }
            }
            if (hit) return;
            if (_personHeadDetector == null) _personHeadDetector = new PersonHeadDetector();
            _cropPersonHeadDetection = _personHeadDetector.Detect(crop);
            _cropHeadCacheFrame = _curFrame;
            _cropHeadCacheGeometry = geometry;
        }

        void SetPhotoRiskFromDetection(bool priorOverlap)
        {
            bool completed = _personHeadDetection != null && _personHeadDetection.Status == PersonHeadDetectionStatus.Complete;
            if (!completed)
            {
                _photoRiskState = priorOverlap ? "prior-overlap" : "detector-unavailable";
                string failure = _personHeadDetection == null ? "人像检测未执行" : _personHeadDetection.Error;
                _photoRiskReason = (priorOverlap ? "画面与拍摄者经验区域重叠；" : "")
                    + failure + "，请人工检查人体和头皮。";
                return;
            }
            if (_personHeadDetection.HasHead || _personHeadDetection.HasPerson)
            {
                _photoRiskState = "detected";
                string target = _personHeadDetection.HasHead ? "疑似头部" : "疑似人体";
                _photoRiskReason = "本地模型检出" + target + "，建议换帧并人工核查；头部检测不等同头皮检测。";
                return;
            }
            _photoRiskState = priorOverlap ? "prior-overlap" : "unverified";
            _photoRiskReason = (priorOverlap ? "画面与拍摄者经验区域重叠；" : "")
                + "本地模型未检出人体或头部，但可能漏检，不能排除头皮，请人工检查。";
        }

        // For machine-readable QA and bridge state; null is unknown, never a negative detection.
        internal Dictionary<string, object> PersonHeadDetectionSnapshot()
        {
            return DescribePersonHeadDetection(_personHeadDetection);
        }

        internal static Dictionary<string, object> DescribePersonHeadDetection(PersonHeadDetection detection)
        {
            bool complete = detection != null && detection.Status == PersonHeadDetectionStatus.Complete;
            return new Dictionary<string, object> {
                { "status", complete ? "complete" : "unavailable" },
                // A detected head is also positive evidence of a person, even without a body box.
                { "personDetected", complete ? (object)(detection.HasPerson || detection.HasHead) : null },
                { "headDetected", complete ? (object)detection.HasHead : null },
                { "scalpDetected", null },
                { "model", "yolov9_t_wholebody34_0100_1x3x640x640" },
                { "modelSha256", PersonHeadDetector.ExpectedSha256 },
                { "scoreThreshold", PersonHeadDetector.ScoreThreshold },
                { "error", complete || detection == null ? null : detection.Error }
            };
        }

        void DisposePersonHeadDetector()
        {
            if (_personHeadDetector != null) { _personHeadDetector.Dispose(); _personHeadDetector = null; }
            ClearPersonHeadDetection();
        }
    }
}
