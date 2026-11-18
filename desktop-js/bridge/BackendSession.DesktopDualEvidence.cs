using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text.Json;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        // 仅供本机 QA 按需调用；返回成功配对的原始观测，不执行搜索、不更改会话。
        object DesktopDualEvidence()
        {
            try
            {
                UtmTree tree = _utmForest != null && _selUtmTree >= 0 && _selUtmTree < _utmForest.Trees.Count
                    ? _utmForest.Trees[_selUtmTree] : null;
                DualFrameResult result = _dualFrameCur;
                if (tree == null || _curFrame == null || !_markHasSpan || !_dualFrameEnabled ||
                    HasManualMark(tree.Id) || result == null || result.Status != DualFrameStatus.Success ||
                    result.Reason != FallbackReason.None) return EmptyDualEvidence("not_success");

                DualFramePairEvidence evidence = result.Evidence;
                if (evidence == null || evidence.A == null || evidence.B == null ||
                    !evidence.MatchesSelection(tree, _dataSetId, _curName, result.FrameB, result.PairAttempts,
                                               (double)_cal, (double)_calV, _levelView, Proj.NaturalD) ||
                    !string.Equals(result.FrameA, evidence.FrameA, StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(evidence.A.Frame, evidence.FrameA, StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(evidence.B.Frame, evidence.FrameB, StringComparison.OrdinalIgnoreCase))
                    return EmptyDualEvidence("selection_mismatch");
                if (_frames == null || string.IsNullOrEmpty(_zipPath) || !File.Exists(_zipPath))
                    return EmptyDualEvidence("source_missing");

                using (Bitmap a = DualFrameImageEvidence.LoadSmallFrame(_frames, evidence.FrameA))
                using (Bitmap b = DualFrameImageEvidence.LoadSmallFrame(_frames, evidence.FrameB))
                {
                    if (a == null || b == null) return EmptyDualEvidence("source_missing");
                    if (!DualFrameImageEvidence.Matches(a, evidence.A) ||
                        !DualFrameImageEvidence.Matches(b, evidence.B))
                        return EmptyDualEvidence("analysis_pixels_changed");
                    using (Bitmap markedA = DualFrameImageEvidence.MarkObservation(a, evidence.A))
                    using (Bitmap markedB = DualFrameImageEvidence.MarkObservation(b, evidence.B))
                    {
                        if (markedA == null || markedB == null) return EmptyDualEvidence("invalid_observation");
                        var response = new Dictionary<string, object> {
                            { "state", "available" }, { "reason", "success_pair_observations_not_identity" },
                            { "treeId", tree.Id }, { "treeIndex", _selUtmTree + 1 },
                            { "frameA", evidence.FrameA }, { "frameB", evidence.FrameB },
                            { "attempt", evidence.Attempt }, { "hashFormat", DualFrameImageEvidence.HashFormat },
                            { "observationA", ObservationInfo(evidence.A) },
                            { "observationB", ObservationInfo(evidence.B) },
                            { "panoA", null }, { "panoAMarked", null }, { "panoB", null }, { "panoBMarked", null }
                        };
                        string panoA = DualFrameImageEvidence.PngDataUrl(a, evidence.A.AnalysisPixelSha256);
                        string panoAMarked = DualFrameImageEvidence.PngDataUrl(markedA);
                        string panoB = DualFrameImageEvidence.PngDataUrl(b, evidence.B.AnalysisPixelSha256);
                        string panoBMarked = DualFrameImageEvidence.PngDataUrl(markedB);
                        if (!DualFrameImageEvidence.FitsJsonLineBudget(JsonSerializer.Serialize(response).Length,
                                                                       panoA, panoAMarked, panoB, panoBMarked))
                            return EmptyDualEvidence("evidence_size_limit");
                        response["panoA"] = panoA; response["panoAMarked"] = panoAMarked;
                        response["panoB"] = panoB; response["panoBMarked"] = panoBMarked;
                        return response;
                    }
                }
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 图证生成失败: " + ex.Message);
                return EmptyDualEvidence("evidence_generation_failed");
            }
        }

        static Dictionary<string, object> ObservationInfo(DualFrameObservationEvidence value)
        {
            return new Dictionary<string, object> {
                { "frame", value.Frame }, { "azimuthDeg", value.AzimuthDeg },
                { "elevationTopDeg", value.ElevationTopDeg }, { "elevationBottomDeg", value.ElevationBottomDeg },
                { "widthDeg", value.WidthDeg }, { "azimuthOriginDeg", value.AzimuthOriginDeg },
                { "verticalCalibrationDeg", value.VerticalCalibrationDeg },
                { "x", value.X }, { "yTop", value.YTop }, { "yBottom", value.YBottom },
                { "width", value.Width }, { "height", value.Height },
                { "analysisPixelSha256", value.AnalysisPixelSha256 }
            };
        }

        static Dictionary<string, object> EmptyDualEvidence(string reason)
        {
            return new Dictionary<string, object> {
                { "state", "unavailable" }, { "reason", reason },
                { "treeId", null }, { "treeIndex", null }, { "frameA", null }, { "frameB", null },
                { "attempt", null }, { "hashFormat", null }, { "observationA", null },
                { "observationB", null }, { "panoA", null }, { "panoAMarked", null },
                { "panoB", null }, { "panoBMarked", null }
            };
        }
    }
}
