using System;
using System.Collections.Generic;
using System.Drawing;

namespace TreeExtractor
{
    // 一次会话对应一套数据和当前分析状态；不创建任何桌面控件或窗口。
    public sealed partial class BackendSession : IDisposable
    {
        decimal _bearing = 100m, _distance = 25m, _elevation = 2m;
        decimal _cal = 0m, _calV = 0m, _cropWidth = 36m, _cropHeight = 36m;
        decimal _viewPan = 180m, _viewTilt = 0m;
        bool _autoFrame = true, _dualFrameEnabled = DualFrameConfig.EnabledDefault;
        bool _lowDistortion = true, _lockView = true;
        string _zipPath, _posePath, _status = "", _markMode = "未选中树", _recognition = "";
        string _heatTitle = "识别注意力热力图（本地模型）";
        readonly PanoramaRenderer _pano;
        Bitmap _photo, _crop, _heat;
        double _markElBase, _markElTop; // 树底/树顶的世界仰角（矫正视角标注用）
        double _markElCrown;           // 树号锚点（树顶往下20%树高）的世界仰角
        double _markElTrunk;           // 红圈锚点（树干段）的世界仰角：红圈对准树干而不是树冠
        double _markAzTrunk;           // 红圈锚点（树干轴心）的世界方位：树干轴心≠树冠重心
        double _markAzL, _markElL, _markAzR, _markElR; // 树冠左/右边缘的世界方位/仰角（画树框用）
        double _markFracBase, _markFracTop; // 树底/树顶在矫正视角图内的纵向位置(0~1)
        double _markFracCrown;         // 树号锚点在4:3照片内的纵向位置(0~1)（红线避让用）
        double _markFracTrunk;         // 红圈锚点(树干)在4:3照片内的纵向位置(0~1)
        double _markFracTrunkX;        // 红圈锚点(树干)在4:3照片内的横向位置(0~1)
        double _markFracLeft, _markFracRight; // 树冠左/右边缘在4:3照片内的横向位置(0~1)
        bool _markHasSpan;          // 是否算出了整棵树的竖向范围
        int _markTreeNo = 0;        // 当前标注树号(0=无)
        // 手动拖动的偏移：树号 → [dAz°,dEl°]（相对自动树干锚点的偏移，逐帧无关，每棵树各自记忆）。
        // 偏移叠加到全部标注几何上，实现「整树标注整体平移」——绿框/红竖线/黄刻度/红圈/树号一起走。
        Dictionary<int, double[]> _markManual;
        // 当前生效的手动偏移（ApplyMarkOffset 叠加的那对 dAz/dEl，无手动时为 0）：
        // 切图的渲染中心要跟着它走，见 RefreshCrop
        double _markDAz, _markDEl;
        // 自动（未加手动偏移）的标注几何：手动偏移叠在它上面，见 ApplyMarkOffset
        double _autoElBase, _autoElTop, _autoElCrown, _autoElTrunk;
        double _autoAzTrunk, _autoAzL, _autoElL, _autoAzR, _autoElR;
        // manual_marks.csv 的偏移始终相对历史单帧锚点，不能随双帧结果改变基点。
        double _manualBaseAzTrunk, _manualBaseElTrunk;
        // false 保留近距离与画质综合选帧；true 按水平距离严格选最近相机。
        bool _strictNearestFrame;
        // 底部 4:3 照片的「水平视角」：光轴仰角固定 0°，地平线严格水平；
        // 树顶超出画幅时自动移轴（shift）把成像窗口上移，保证整树入框且不拍到脚下。
        // 关闭后回到原来的「瞄准点为中心」的仰视视角。
        bool _levelView = true;
        double _photoShift;         // 当前 4:3 渲染的移轴量（拖动反投影必须用同一个值）
        double _photoBearing, _photoElev, _photoHf, _photoVf; // 4:3照片当前渲染视角参数（拖动反投影用）

        PoseIndex _poses;
        FrameStore _frames;
        Bitmap _curFrame;
        Bitmap _recogClean;   // 底部4:3照片的干净副本（未烤树号），供拖动重绘
        Bitmap _cropClean;    // 右上角切图的干净副本（未烤树号），树木识别/热力图的输入
        string _curName = "";
        UtmForest _utmForest;          // UTM 树心数据（从 xlsx 导出）
        Dictionary<int, double> _crownR; // 点云实测树冠水平半径：树号 → 半径(m)（crown.csv）
        Dictionary<int, double[]> _trunkXy; // 点云实测树干轴心 UTM：树号 → [X,Y]（trunk.csv）
        Dictionary<string, double[]> _metaPose; // Metashape 姿态：帧名 → [X,Y,Z,Omega,Phi,Kappa]
        int _fitTree = -1;            // 上次自动适配视场角时的树索引
        double _fitGps = double.NaN;  // 上次自动适配视场角时的帧 GPS
        int _selUtmTree = -1;          // 当前选中的 UTM 树索引
        double _curPanoRef;      // 当前帧全景图"第0列"对应的世界方位角(°)


        // 全景图第0列的世界方位角 = 相机 +Y 轴的世界方位（由 Metashape 的 Omega/Phi/Kappa 求得）。
        // 360 相机随机身一起转，所以这个方位逐帧不同；IMU 航向(Heading)实测偏差约 90°，
        // 不可用。本式经两种独立方法校验（点云树冠天际线互相关、相邻帧旋转一致性），误差约 ±2°。
        static double PanoAzimuthFromOpk(double omega, double phi, double kappa)
        {
            double co = Math.Cos(Geo.Rad(omega)), so = Math.Sin(Geo.Rad(omega));
            double cp = Math.Cos(Geo.Rad(phi)), sp = Math.Sin(Geo.Rad(phi));
            double ck = Math.Cos(Geo.Rad(kappa)), sk = Math.Sin(Geo.Rad(kappa));
            // R = Rz(kappa)·Ry(phi)·Rx(omega)，取第二列 R·[0,1,0]
            double e = ck * sp * so - sk * co;
            double n = sk * sp * so + ck * co;
            return Geo.Wrap360(Geo.Deg(Math.Atan2(e, n)));
        }

        // 指定帧的全景方位基准：优先 Metashape 姿态，缺帧时退回 IMU 航向
        double PanoRefOf(string frameName, Pose p)
        {
            double[] mp;
            if (_metaPose != null && frameName != null && _metaPose.TryGetValue(frameName, out mp))
                return PanoAzimuthFromOpk(mp[3], mp[4], mp[5]);
            return p != null ? p.Heading : 0.0;
        }

        // 取景中心：矫正视角照片/切图的画面中心落在这个高度（0.30×树高），
        // 目的是让整棵树尽量完整入框（配平树底/树顶到中心的仰角差）。
        // 注意：它不是红圈位置——红圈另取树干段 TrunkMarkH。
        internal static double AimHeight(double height)
        {
            return Math.Min(Math.Max(height * 0.30, 1.8), height * 0.85);
        }
        static UtmTree AimTrunk(UtmTree t)
        {
            return new UtmTree
            {
                Id = t.Id, X = t.X, Y = t.Y,
                Z = t.Z + AimHeight(t.Height),
                Height = t.Height, Species = t.Species
            };
        }

        // 缺少可靠双帧观测时，用树高估算红圈锚点：0.042×树高，限制在 0.42~0.75 m。
        // 这是旧数据上的经验值，并非可见树干中点的测量；遮挡、分叉或配准误差均可能导致偏移。
        static double TrunkMarkH(double height)
        {
            return Geo.Clamp(height * 0.042, 0.42, 0.75);
        }

        // 历史人工标注基点的横向修正（°）；仅为兼容旧人工校正保留。
        const double TrunkAzBias = 2.7;

        // 红圈/红十字要钉住的世界仰角：UTM 模式取树干锚点，非 UTM 模式没有树干数据，退回瞄准仰角。
        // 两处红圈（底部4:3照片的圆、全景预览的十字）必须用同一个值，才指向树干同一点。
        double MarkEye(double elev)
        {
            return _markHasSpan ? _markElTrunk : elev;
        }

        // 红圈/红十字要钉住的世界方位：UTM 模式取「树干轴心」的方位（由点云实测，见
        // TrunkAxisUtm），非 UTM 模式没有树干数据，退回树方位。
        double MarkAz(double bearing)
        {
            return _markHasSpan ? _markAzTrunk : bearing;
        }

        // 树干轴心的 UTM 坐标：树心文件给的是树冠重心，与树干轴心差 0.04~0.43m
        // （105号 0.15m）——3m 近距下就是 2~3° 的横向偏差，红圈会压在树干边缘。
        // trunk.csv 是离线从点云逐棵树量出的树干轴心（树干带重心），这里直接取用。
        // 返回 false 表示该树没有实测干心，退回树心坐标；旧人工校正另有兼容基点。
        bool TrunkAxisUtm(UtmTree t, out double tx, out double ty)
        {
            double[] v;
            if (_trunkXy != null && _trunkXy.TryGetValue(t.Id, out v) && v != null && v.Length >= 2 &&
                !double.IsNaN(v[0]) && !double.IsInfinity(v[0]) &&
                !double.IsNaN(v[1]) && !double.IsInfinity(v[1]))
            {
                tx = v[0]; ty = v[1];
                return true;
            }
            tx = t.X; ty = t.Y;
            return false;
        }

        void SetTreeTarget(double bearing, double dist, double elev)
        {
            SetTargetInputs(bearing, dist, elev);
            SafeRecompute();
        }

        // 批量设置目标，调用方负责在末尾重新计算一次。
        void SetTargetInputs(double bearing, double dist, double elev)
        {
            _bearing = (decimal)Geo.Wrap360(bearing);
            // 水平最近模式允许相机与目标极近甚至重合；不能把合法的零距离当作选帧失败。
            _distance = (decimal)Geo.Clamp(dist, 0, 1000);
            _elevation = (decimal)Geo.Clamp(elev, -90, 90);
        }

        // 供「树心-全景对照表」调用：切到指定全景帧，并把视角对准该树
        public bool GotoFrame(string frameName, double bearing, double dist, double elev)
        {
            if (_frames == null || _frames.Frames.Count == 0) return false;
            int idx = -1;
            for (int i = 0; i < _frames.Frames.Count; i++)
                if (_frames.Frames[i].Name == frameName) { idx = i; break; }
            if (idx < 0) return false;
            _manualFrameIdx = idx;
            _autoFrame = false;
            SetTargetInputs(bearing, dist, elev);
            SafeRecompute();
            return true;
        }


        public BackendSession()
        {
            _markManual = new Dictionary<int, double[]>();
            _pano = new PanoramaRenderer();
            _zipPath = AppPaths.ZipPath;
            _posePath = AppPaths.PosePath;
            Proj.NaturalD = Proj.LowDistortionD;
        }

        void SafeRecompute()
        {
            if (_recomputing) return;
            _recomputing = true;
            try { Recompute(); }
            catch (Exception ex)
            {
                // 选树/换帧中断时，旧图不再属于当前目标，不能继续展示为有效结果。
                string message = "无法生成当前树的照片：" + ex.Message;
                BackendLog.Write(message);
                ClearUnavailableFrame(message);
            }
            finally { _recomputing = false; }
        }

        public void Dispose()
        {
            DisposePersonHeadDetector();
            _pano.Dispose();
            _curFrame = null;
            ReplaceImage(ref _photo, null);
            ReplaceImage(ref _crop, null);
            ReplaceImage(ref _heat, null);
            ReplaceImage(ref _recogClean, null);
            ReplaceImage(ref _cropClean, null);
            if (_frames != null) { _frames.Dispose(); _frames = null; }
        }
    }
}
