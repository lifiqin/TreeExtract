using System;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        double _previewFov = 90.0;
        bool _recomputing;

        void PushPanoTarget()
        {
            // 有树但无法生成可靠标注时，只显示全景，不复用上一帧的红十字。
            bool hideTarget = _utmForest != null && _selUtmTree >= 0 && !_markHasSpan;
            double treePan = hideTarget ? double.NaN : Geo.Wrap360(MarkAz((double)_bearing) - (_curPanoRef + (double)_cal));
            double treeEye = hideTarget ? double.NaN : MarkEye((double)_elevation) + (double)_calV;
            _pano.SetTarget((double)_viewPan, (double)_viewTilt, treePan, treeEye, _previewFov);
        }

        void SyncLockViewToMark(double bearing, double elevation)
        {
            if (!_lockView) return;
            _viewPan = (decimal)Geo.Wrap360(MarkAz(bearing) - (_curPanoRef + (double)_cal));
            _viewTilt = (decimal)Geo.Clamp(MarkEye(elevation) + (double)_calV, -89, 89);
        }

        void UnlockView() { _lockView = false; }
    }
}
