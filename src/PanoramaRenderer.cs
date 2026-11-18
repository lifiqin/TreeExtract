using System;
using System.Drawing;
using System.Drawing.Imaging;

namespace TreeExtractor
{
    // 同步、按需渲染全景预览；不创建控件、窗口或后台 UI 线程。
    internal sealed class PanoramaRenderer : IDisposable
    {
        readonly object _sourceLock = new object();
        readonly Font _labelFont = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
        Bitmap _source;
        double _pan = 180, _tilt, _treePan = 180, _treeEye, _fov = 90;

        internal object SyncRoot { get { return _sourceLock; } }

        internal void SetSource(Bitmap source)
        {
            lock (_sourceLock)
            {
                Bitmap old = _source;
                _source = source;
                if (old != null && !ReferenceEquals(old, source)) old.Dispose();
            }
        }

        internal void SetTarget(double pan, double tilt, double treePan, double treeEye, double fov)
        {
            _pan = pan; _tilt = tilt; _treePan = treePan; _treeEye = treeEye; _fov = fov;
        }

        internal Bitmap RenderSnapshot(int width, int height)
        {
            width = Math.Max(320, Math.Min(width, 1600));
            height = Math.Max(200, Math.Min(height, 1000));
            lock (_sourceLock)
            {
                if (_source == null) return null;
                Bitmap result = new Bitmap(width, height, PixelFormat.Format32bppArgb);
                try { RenderFrame(_source, _pan, _tilt, _treePan, _treeEye, _fov, result); return result; }
                catch { result.Dispose(); throw; }
            }
        }

        public void Dispose()
        {
            SetSource(null);
            _labelFont.Dispose();
        }

        void RenderFrame(Bitmap src, double panDeg, double tiltDeg, double treePanDeg, double treeEyeDeg, double fovDeg, Bitmap dst)
        {
            int srcW = src.Width, srcH = src.Height;
            int bw = dst.Width, bh = dst.Height;   // 缓冲尺寸随面板变化
            double hf = Geo.Rad(fovDeg);
            double vf = hf * bh / bw;
            double th = Math.Tan(hf / 2), tv = Math.Tan(vf / 2);
            double pan = Geo.Rad(panDeg), tilt = Geo.Rad(tiltDeg);
            double cp = Math.Cos(pan), sp = Math.Sin(pan), ct = Math.Cos(tilt), st = Math.Sin(tilt);
            double fX = sp * ct, fY = cp * ct, fZ = st;   // 视线 forward
            double rX = cp, rY = -sp;                     // 视线 right
            double uX = -sp * st, uY = -cp * st, uZ = ct; // 视线 up
            var sd = src.LockBits(new Rectangle(0, 0, srcW, srcH),
                System.Drawing.Imaging.ImageLockMode.ReadOnly, src.PixelFormat);
            var dd = dst.LockBits(new Rectangle(0, 0, bw, bh),
                System.Drawing.Imaging.ImageLockMode.WriteOnly,
                System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            int srcBpp = System.Drawing.Image.GetPixelFormatSize(src.PixelFormat) / 8;
            if (srcBpp < 3) srcBpp = 3;
            try
            {
                unsafe
                {
                    byte* sPtr = (byte*)sd.Scan0;
                    byte* dPtr = (byte*)dd.Scan0;
                    int sStride = sd.Stride, dStride = dd.Stride;
                    double azToSx = srcW / (2.0 * Math.PI);
                    for (int y = 0; y < bh; y++)
                    {
                        byte* dstRow = dPtr + y * dStride;
                        double ny = 1.0 - 2.0 * y / (double)(bh - 1);
                        double Y = ny * tv;
                        for (int x = 0; x < bw; x++)
                        {
                            double nx = 2.0 * x / (double)(bw - 1) - 1.0;
                            double X = nx * th;
                            double Rx = X * rX + Y * uX + fX;
                            double Ry = X * rY + Y * uY + fY;
                            double Rz = Y * uZ + fZ;
                            double az = Math.Atan2(Rx, Ry);
                            double el = Math.Atan2(Rz, Math.Sqrt(Rx * Rx + Ry * Ry));
                            double sx = az * azToSx;
                            if (sx < 0) sx += srcW;
                            // 双线性采样：缩小时(900缓冲<源信息量)不会丢像素出颗粒，放大时边缘平滑
                            double sy = (Math.PI / 2.0 - el) / Math.PI * srcH;
                            if (sy < 0) sy = 0; else if (sy > srcH - 1) sy = srcH - 1;
                            int x0 = (int)sx; if (x0 >= srcW) x0 -= srcW;
                            int x1 = x0 + 1; if (x1 >= srcW) x1 -= srcW;
                            int y0 = (int)sy; int y1 = y0 + 1; if (y1 > srcH - 1) y1 = srcH - 1;
                            double fx = sx - x0, fy = sy - y0;
                            byte* p00 = sPtr + y0 * sStride + x0 * srcBpp;
                            byte* p01 = sPtr + y0 * sStride + x1 * srcBpp;
                            byte* p10 = sPtr + y1 * sStride + x0 * srcBpp;
                            byte* p11 = sPtr + y1 * sStride + x1 * srcBpp;
                            double w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
                            dstRow[x * 4] = (byte)(p00[0] * w00 + p01[0] * w01 + p10[0] * w10 + p11[0] * w11 + 0.5);
                            dstRow[x * 4 + 1] = (byte)(p00[1] * w00 + p01[1] * w01 + p10[1] * w10 + p11[1] * w11 + 0.5);
                            dstRow[x * 4 + 2] = (byte)(p00[2] * w00 + p01[2] * w01 + p10[2] * w10 + p11[2] * w11 + 0.5);
                            dstRow[x * 4 + 3] = 255;
                        }
                    }
                }
            }
            finally
            {
                src.UnlockBits(sd);
                dst.UnlockBits(dd);
            }
            DrawOverlays(dst, panDeg, tiltDeg, treePanDeg, treeEyeDeg, fovDeg);
        }

        void DrawOverlays(Bitmap b, double panDeg, double tiltDeg, double treePanDeg, double treeEyeDeg, double fovDeg)
        {
            int bw = b.Width, bh = b.Height;
            float scale = bw / 960f;
            using (var g = Graphics.FromImage(b))
            {
                // 红十字=树心方向：用与渲染完全相同的透视投影把世界方向 (treePan,treeEye)
                // 投到画面上，保证十字真的钉在该方向的像素上（旧公式忽略视角俯仰耦合，高仰角时偏）
                double a = Geo.Rad(treePanDeg), e2 = Geo.Rad(treeEyeDeg);
                double p = Geo.Rad(panDeg), t = Geo.Rad(tiltDeg);
                double hFov = Geo.Rad(fovDeg);
                double vFov = hFov * bh / bw;
                double ce = Math.Cos(e2), se = Math.Sin(e2), da = a - p;
                double ct = Math.Cos(t), st = Math.Sin(t);
                double Xd = ce * Math.Sin(da);
                double Yd = se * ct - ce * Math.Cos(da) * st;
                double Fd = ce * ct * Math.Cos(da) + se * st;
                if (Fd > 0)
                {
                    double nx = Xd / Fd / Math.Tan(hFov / 2);
                    double ny = Yd / Fd / Math.Tan(vFov / 2);
                    if (Math.Abs(nx) <= 1.06 && Math.Abs(ny) <= 1.06)
                    {
                        float tx = (float)(bw / 2 + nx * bw / 2);
                        float ty = (float)(bh / 2 - ny * bh / 2);
                        using (var pen = new Pen(Color.Red, 2.5f * scale))
                        {
                            g.DrawLine(pen, tx - 24 * scale, ty, tx + 24 * scale, ty);
                            g.DrawLine(pen, tx, ty - 24 * scale, tx, ty + 24 * scale);
                            g.DrawEllipse(pen, tx - 36 * scale, ty - 36 * scale, 72 * scale, 72 * scale);
                        }
                    }
                }
                string txt = "viewPan=" + panDeg.ToString("f1") + "°   viewTilt=" + tiltDeg.ToString("f1") + "°";
                using (var font = new Font(_labelFont.FontFamily, _labelFont.Size * scale, _labelFont.Style))
                {
                    g.DrawString(txt, font, Brushes.Black, 13 * scale, 13 * scale);
                    g.DrawString(txt, font, Brushes.Yellow, 11 * scale, 11 * scale);
                }

            }
        }

    }
}
