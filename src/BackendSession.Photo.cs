using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        static void ReplaceImage(ref Bitmap slot, Bitmap image)
        {
            Bitmap old = slot;
            slot = image;
            if (old != null && !ReferenceEquals(old, image)) old.Dispose();
        }

        // 等距柱状全景 → 径向球面透视视角（d=0 时退化为矩形直线/针孔投影）。
        // 近树为了装下整棵树，4:3 视场会到 120° 以上，纯针孔会把边缘枝叶拉成放射状；
        // d=1 的球极平面投影减轻局部形状拉伸，但会改变边缘视场且直线可能弯曲。
        // shift = 移轴量（成像窗口上移）：光轴保持水平时地平线仍是直线，但树顶能进画面，
        // 底边同时抬高、不会把脚架/拍摄者带进来（见 UpdateNearestPhoto 的 AutoLevelShift）。
        Bitmap RenderRectilinear(Bitmap src, double az0, double el0, double hfDeg, double vfDeg,
                                 double panoRef, double cal, double calV, int targetW = 0, double shift = 0.0)
        {
            if (src == null || src.Width < 8 || src.Height < 8) return null;
            hfDeg = Geo.Clamp(hfDeg, 1, FovMax);
            vfDeg = Geo.Clamp(vfDeg, 1, FovMax);
            int srcW = src.Width, srcH = src.Height;
            double th = Proj.HalfScale(hfDeg / 2.0), tv = Proj.HalfScale(vfDeg / 2.0);
            int outW = (int)Math.Round(hfDeg / 360.0 * srcW);
            // targetW>0（底部4:3照片）时严格按 targetW 渲染；hf 由 Proj.Hfov 推出，
            // 保证 th/tv=4/3，因此 outH 恒为 targetW×3/4（1280×960）。
            if (targetW > 0) outW = targetW;
            int outH = (int)Math.Round(outW * tv / th);
            outW = (int)Geo.Clamp(outW, 16, 2400);
            outH = (int)Geo.Clamp(outH, 16, 2400);
            var dst = new Bitmap(outW, outH, PixelFormat.Format32bppArgb);
            var sd = src.LockBits(new Rectangle(0, 0, srcW, srcH),
                ImageLockMode.ReadOnly, src.PixelFormat);
            var dd = dst.LockBits(new Rectangle(0, 0, outW, outH),
                ImageLockMode.WriteOnly,
                PixelFormat.Format32bppArgb);
            int bpp = Image.GetPixelFormatSize(src.PixelFormat) / 8;
            if (bpp < 3) bpp = 3;
            try
            {
                unsafe
                {
                    byte* sPtr = (byte*)sd.Scan0;
                    byte* dPtr = (byte*)dd.Scan0;
                    int sStride = sd.Stride, dStride = dd.Stride;
                    double p0 = Geo.Rad(az0), e0 = Geo.Rad(el0);
                    double cp = Math.Cos(p0), sp = Math.Sin(p0), ce = Math.Cos(e0), se = Math.Sin(e0);
                    double fX = sp * ce, fY = cp * ce, fZ = se;   // 视线 forward
                    double rX = cp, rY = -sp;                     // 视线 right
                    double uX = -sp * se, uY = -cp * se, uZ = ce; // 视线 up
                    double azOff = Geo.Rad(panoRef + cal);       // 与红十字相同的方位基准
                    double elOff = Geo.Rad(calV);
                    double azToSx = srcW / (2.0 * Math.PI);
                    double d = Proj.NaturalD, d1 = d + 1.0;
                    for (int j = 0; j < outH; j++)
                    {
                        double v = outH == 1 ? 0 : 1 - 2.0 * j / (outH - 1);
                        double Y0 = (v + shift) * tv;
                        byte* dRow = dPtr + j * dStride;
                        for (int i = 0; i < outW; i++)
                        {
                            double u = outW == 1 ? 0 : 2.0 * i / (outW - 1) - 1;
                            double X0 = u * th;
                            // 径向球面透视逆投影：先求前向分量 Z，再还原相机坐标 X/Y。
                            // d=0 时 Z=1/sqrt(1+X0²+Y0²)，与旧针孔射线仅差一个正标量，
                            // atan2 取方向后逐像素等价，所以旧的小视场画面不会改变。
                            double r2 = X0 * X0 + Y0 * Y0;
                            double qa = r2 + d1 * d1, qb = 2.0 * d * r2, qc = r2 * d * d - d1 * d1;
                            double z = (-qb + Math.Sqrt(qb * qb - 4.0 * qa * qc)) / (2.0 * qa);
                            double k = (d + z) / d1;
                            double X = X0 * k, Y = Y0 * k;
                            double Rx = X * rX + Y * uX + z * fX;
                            double Ry = X * rY + Y * uY + z * fY;
                            double Rz = Y * uZ + z * fZ;
                            double az = Math.Atan2(Rx, Ry);
                            double el = Math.Atan2(Rz, Math.Sqrt(Rx * Rx + Ry * Ry));
                            double sx = (az - azOff) * azToSx;
                            sx -= Math.Floor(sx / srcW) * srcW;                 // 经度 360° 环绕
                            double sy = (Math.PI / 2 - el - elOff) / Math.PI * srcH;
                            sy = Geo.Clamp(sy, 0, srcH - 1);
                            int x0 = (int)sx; if (x0 >= srcW) x0 = 0;
                            int x1 = x0 + 1; if (x1 >= srcW) x1 -= srcW;
                            int y0 = (int)sy; int y1 = y0 + 1; if (y1 > srcH - 1) y1 = srcH - 1;
                            double fx = sx - x0, fy = sy - y0;
                            byte* p00 = sPtr + y0 * sStride + x0 * bpp;
                            byte* p01 = sPtr + y0 * sStride + x1 * bpp;
                            byte* p10 = sPtr + y1 * sStride + x0 * bpp;
                            byte* p11 = sPtr + y1 * sStride + x1 * bpp;
                            byte* o = dRow + i * 4;
                            double w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
                            o[0] = (byte)(p00[0] * w00 + p01[0] * w01 + p10[0] * w10 + p11[0] * w11 + 0.5);
                            o[1] = (byte)(p00[1] * w00 + p01[1] * w01 + p10[1] * w10 + p11[1] * w11 + 0.5);
                            o[2] = (byte)(p00[2] * w00 + p01[2] * w01 + p10[2] * w10 + p11[2] * w11 + 0.5);
                            o[3] = 255;
                        }
                    }
                }
            }
            finally
            {
                src.UnlockBits(sd);
                dst.UnlockBits(dd);
            }
            return dst;
        }

        // 最近照片：显示当前帧矫正后的普通视角。
        // 默认「水平视角」：光轴仰角 0°（地平线严格水平），树顶超出画幅时自动移轴；
        // 关掉水平视角则沿用瞄准点为中心的仰视构图。画面中心仍按 4:3 视场装下整棵树。
        void UpdateNearestPhoto(double bearing, double elev, double tiltD, double cal, double calV)
        {
            bool level = _levelView && _markHasSpan;
            double viewEl = level ? 0.0 : elev;
            double vf = Geo.Clamp(tiltD, 1.0, VF43Max);
            if (_markHasSpan)
            {
                // 用「自动」树底/树顶算视场：手动拖动只平移标注，不该改变画幅视场（否则会跳变）。
                // 水平视角下光轴在 0°，上下需求分别是 -树底 与 树顶；仰视下则以瞄准点平分。
                double span = level
                    ? 2.0 * Math.Max(-_autoElBase, _autoElTop) + 8.0
                    : 2.0 * Math.Max(elev - _autoElBase, _autoElTop - elev) + 8.0;
                vf = Math.Min(Math.Max(span, 40.0), VF43Max);
            }
            double hf = Proj.Hfov(vf, 4.0 / 3.0);
            double shift = level ? AutoLevelShift(bearing, viewEl, hf, vf) : 0.0;
            // 记下本次渲染的视角参数：拖动红圈时用它把鼠标像素反投影成世界方向
            _photoBearing = bearing; _photoElev = viewEl; _photoHf = hf; _photoVf = vf;
            _photoShift = shift;
            Bitmap view = null;
            lock (_pano.SyncRoot)
            {
                if (_curFrame != null)
                    view = RenderRectilinear(_curFrame, bearing, viewEl, hf, vf, _curPanoRef, cal, calV, 1280, shift);
            }
            // 检查原始照片而不是烤入树号/红圈后的图像；未检出并不代表无人。
            UpdatePersonHeadDetection(view, cal, calV);
            if (view != null)
            {
                // 留一份没烤树号的干净副本：一份给树木识别（大白数字会干扰模型看树），
                // 一份供拖动红圈时快速重绘标记（免去整张重投影）
                var clean = (Bitmap)view.Clone();
                if (_recogClean != null) _recogClean.Dispose();
                _recogClean = clean;
            }
            ComputeMarkFracs(bearing, viewEl, hf, vf, shift);
            if (view != null)
            {
                // 树号烤进底部4:3照片（与切图同款：树冠锚点投影处、树顶往下20%树高，白字黑描边）
                if (_markHasSpan && _markTreeNo > 0) DrawTreeNoOnCrown(view, bearing, viewEl, hf, vf, shift);
                // 标记与像素一起渲染，缩放或导出时保持对齐。
                if (_markHasSpan) DrawMarkOnBitmap(view);
            }
            ReplaceImage(ref _photo, view);
            // 切树后旧热力图不再对应当前树，清空并取消后台任务
            if (_heatTreeNo > 0 && _heatTreeNo != _markTreeNo)
                ClearHeat("已切换树，重新本地识别后显示");
        }

        // 自动移轴：树顶离画面上缘不足 6% 时，把成像窗口上移，让树顶回到 6% 处；
        // 同时约束移轴量，保证树底不被裁出下缘（鱼与熊掌不可兼得时宁可不移）。
        // 返回 0 表示树顶本来就在框内——普通树因此与「水平常规」完全一致。
        double AutoLevelShift(double bearing, double viewEl, double hf, double vf)
        {
            const double topMargin = 0.06, bottomLimit = 0.98;
            if (!_markHasSpan) return 0.0;
            double th = Proj.HalfScale(hf / 2.0), tv = Proj.HalfScale(vf / 2.0);
            double fx, fyTop, fyBase;
            Proj.PixelFromWorld(bearing, _autoElTop, bearing, viewEl, th, tv, 0.0, out fx, out fyTop);
            if (fyTop >= topMargin) return 0.0;
            double shift = 2.0 * (topMargin - fyTop);
            Proj.PixelFromWorld(bearing, _autoElBase, bearing, viewEl, th, tv, 0.0, out fx, out fyBase);
            double maxShift = 2.0 * (bottomLimit - fyBase);
            if (maxShift < 0) maxShift = 0;
            return Math.Min(shift, maxShift);
        }

        // 树底/树顶/树号/红圈/树框在 4:3 照片内的位置(0~1)，由当前视角参数算出。
        // 与 RenderRectilinear 共用 Proj.PixelFromWorld：投影参数、相机基向量完全一致，
        // 不再用「同方位近似」的 tan 公式，树框左右缘的纵向位置也不会因大仰角而算偏。
        void ComputeMarkFracs(double bearing, double elev, double hf, double vf, double shift = 0.0)
        {
            double th = Proj.HalfScale(hf / 2.0), tv = Proj.HalfScale(vf / 2.0);
            double fx, fy;
            Proj.PixelFromWorld(bearing, _markElBase, bearing, elev, th, tv, shift, out fx, out _markFracBase);
            Proj.PixelFromWorld(bearing, _markElTop, bearing, elev, th, tv, shift, out fx, out _markFracTop);
            Proj.PixelFromWorld(bearing, _markElCrown, bearing, elev, th, tv, shift, out fx, out _markFracCrown);
            // 红圈用树干轴心方位，不能固定取画面中心（树心是树冠重心，与干心可差约 1°）
            Proj.PixelFromWorld(_markAzTrunk, _markElTrunk, bearing, elev, th, tv, shift,
                                out _markFracTrunkX, out _markFracTrunk);
            Proj.PixelFromWorld(_markAzL, _markElL, bearing, elev, th, tv, shift, out _markFracLeft, out fy);
            Proj.PixelFromWorld(_markAzR, _markElR, bearing, elev, th, tv, shift, out _markFracRight, out fy);
        }

        // 把树号印在树冠上：纵向=树冠锚点（树顶往下 20% 树高处）的投影，
        // 横向=树框中线，白字+黑描边，任何背景（绿叶/天空/树皮）上都醒目。
        // 每次按「目标位图自己的视角」重算：4:3 照片与右侧切图视场不同，不能互用比例。
        // 横向取树框中线而不是独立投影树冠锚点，近树/手动偏移时树号仍跟着树框走。
        void DrawTreeNoOnCrown(Bitmap bmp, double azAim, double elevAim, double hfDeg, double vfDeg, double shift = 0.0)
        {
            double th = Proj.HalfScale(hfDeg / 2.0), tv = Proj.HalfScale(vfDeg / 2.0);
            double xl, xr, yc, tmp;
            Proj.PixelFromWorld(_markAzL, _markElL, azAim, elevAim, th, tv, shift, out xl, out tmp);
            Proj.PixelFromWorld(_markAzR, _markElR, azAim, elevAim, th, tv, shift, out xr, out tmp);
            Proj.PixelFromWorld(azAim, _markElCrown, azAim, elevAim, th, tv, shift, out tmp, out yc);
            double fr = Geo.Clamp(yc, 0.06, 0.94);
            double fx = Geo.Clamp((xl + xr) / 2, 0.06, 0.94);
            using (var g = Graphics.FromImage(bmp))
                DrawTreeNo(g, (float)(fx * bmp.Width), (float)(fr * bmp.Height), bmp.Height * 0.14f, _markTreeNo);
        }

        // 底层画树号：GraphicsPath 描边 + 填充（比重复画字清晰）
        static void DrawTreeNo(Graphics g, float cx, float cy, float size, int treeNo)
        {
            if (treeNo <= 0 || size < 6f) return;
            using (var path = new System.Drawing.Drawing2D.GraphicsPath())
            {
                var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                path.AddString(treeNo.ToString(), new FontFamily("Arial"), (int)FontStyle.Bold,
                    size, new PointF(cx, cy), sf);
                using (var pen = new Pen(Color.Black, Math.Max(2f, size * 0.14f)))
                    g.DrawPath(pen, path);
                using (var br = new SolidBrush(Color.White))
                    g.FillPath(br, path);
            }
        }

        // 在4:3照片位图上标树：绿框=树冠左右缘×树底树顶围出的整树范围，
        // 红竖线=树干中轴，黄横线=树底/树顶刻度，红圈=树干锚点(TrunkMarkH)。
        // 全部按比例(0~1)换算成位图像素后直接画进位图，因此与照片像素严格对齐。
        void DrawMarkOnBitmap(Bitmap bmp)
        {
            int W = bmp.Width, H = bmp.Height;
            float k = H / 960f;                       // 线宽/半径随分辨率等比缩放
            float xl = (float)(_markFracLeft * W), xr = (float)(_markFracRight * W);
            float yt = (float)(_markFracTop * H), yb = (float)(_markFracBase * H);
            float mx = (float)(_markFracTrunkX * W), my = (float)(_markFracTrunk * H);
            using (var g = Graphics.FromImage(bmp))
            {
                // 树框：深色描边打底 + 亮绿描边，绿叶/天空/树皮上都看得清
                if (xr - xl > 6f && Math.Abs(yb - yt) > 6f)
                {
                    using (var pen = new Pen(Color.FromArgb(110, 0, 0, 0), 5f * k))
                        g.DrawRectangle(pen, xl, yt, xr - xl, yb - yt);
                    using (var pen = new Pen(Color.FromArgb(235, 80, 255, 120), 2f * k))
                        g.DrawRectangle(pen, xl, yt, xr - xl, yb - yt);
                }
                // 红竖线在树号处断开（树号烤在位图上、位置同 _markFracCrown，穿过去会叠字）
                if (Math.Abs(yb - yt) > 3f)
                {
                    float yc = (float)(_markFracCrown * H);
                    float gap = 0.085f * H;
                    using (var pen = new Pen(Color.FromArgb(200, 255, 60, 60), 2.5f * k))
                    {
                        if (yb - (yc + gap) > 2f) g.DrawLine(pen, mx, yc + gap, mx, yb);
                        if ((yc - gap) - yt > 2f) g.DrawLine(pen, mx, yt, mx, yc - gap);
                    }
                    using (var pen = new Pen(Color.FromArgb(200, 255, 255, 0), 2f * k))
                    {
                        g.DrawLine(pen, mx - 10 * k, yb, mx + 10 * k, yb);
                        g.DrawLine(pen, mx - 10 * k, yt, mx + 10 * k, yt);
                    }
                }
                float r = 18f * k, arm = 30f * k;
                using (var pen = new Pen(Color.White, 3f * k))
                    g.DrawEllipse(pen, mx - r, my - r, 2 * r, 2 * r);
                using (var pen = new Pen(Color.Red, 5f * k))
                    g.DrawEllipse(pen, mx - r, my - r, 2 * r, 2 * r);
                using (var pen = new Pen(Color.Red, 3f * k))
                {
                    g.DrawLine(pen, mx - arm, my, mx + arm, my);
                    g.DrawLine(pen, mx, my - arm, mx, my + arm);
                }
            }
        }

        // 手动偏移始终相对历史单帧锚点，兼容既有 CSV；即时重绘避免整张重投影。
        void SetManualMark(double az, double el)
        {
            if (_utmForest == null || _selUtmTree < 0 || _selUtmTree >= _utmForest.Trees.Count) return;
            if (_markManual == null) _markManual = new Dictionary<int, double[]>();
            int id = _utmForest.Trees[_selUtmTree].Id;
            // 与旧版 CSV 保持同一基点。当前展示可能来自双帧或其回退结果；
            // 如果以该结果为基点存偏移，下次人工优先时切回单帧基点会发生跳动。
            double dAz = Geo.Wrap180(az - _manualBaseAzTrunk);
            double dEl = el - _manualBaseElTrunk;
            _markManual[id] = new double[] { dAz, dEl };
            _markDirty = true;     // 有未保存的拖动结果（「保存校正」按钮提示用）
            _autoAzTrunk = _manualBaseAzTrunk;
            _autoElTrunk = _manualBaseElTrunk;
            ApplyMarkOffset(id);   // 整树标注整体平移（绿框/红竖线/黄刻度/红圈/树号一起走）
            _markMode = "当前：手动（已校正）";
            RedrawMarkOnly();
        }

        // 清除当前树的手动红圈，回到自动树干锚点（要落盘需再点「保存校正」）
        void ClearManualMark()
        {
            if (_utmForest == null || _selUtmTree < 0 || _selUtmTree >= _utmForest.Trees.Count) return;
            int id = _utmForest.Trees[_selUtmTree].Id;
            if (_markManual == null || !_markManual.Remove(id)) return;
            _markDirty = true;
            InvalidateDualFrame(id, false);   // 人工优先解除：该树的双帧缓存必须失效
            SafeRecompute();   // 自动锚点要重算几何
        }

        // 只重画标记：克隆干净副本后重烤树号+标记，并同步全景红十字（不做整张重投影，拖动才跟手）
        void RedrawMarkOnly()
        {
            if (_recogClean != null && _markHasSpan)
            {
                ComputeMarkFracs(_photoBearing, _photoElev, _photoHf, _photoVf, _photoShift);
                var bmp = (Bitmap)_recogClean.Clone();
                if (_markTreeNo > 0) DrawTreeNoOnCrown(bmp, _photoBearing, _photoElev, _photoHf, _photoVf, _photoShift);
                DrawMarkOnBitmap(bmp);
                ReplaceImage(ref _photo, bmp);
            }
            if (_curFrame != null)
            {
                SyncLockViewToMark(_photoBearing, _photoElev);
                PushPanoTarget();
            }
        }
    }
}
