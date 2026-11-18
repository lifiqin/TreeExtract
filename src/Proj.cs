using System;

namespace TreeExtractor
{
    // 投影换算。全景预览（PanoramaRenderer）沿用针孔模型；照片/切图使用径向球面透视投影。
    // 这不是标准的柱面 Pannini 投影：原公式对球面方向的 X/Y 使用同一个径向缩放系数。
    // d=1 时为球极平面投影，局部保形，可减轻广角画面边缘的各向异性拉伸；
    // 代价是直线可能弯曲、边缘仍可能放大。允许回到原 d=0.5 以便对照。
    static class Proj
    {
        public const double LegacyD = 0.5;
        public const double LowDistortionD = 1.0;
        public static double NaturalD = LowDistortionD;

        // 由垂直视场角推水平视场角：使两侧在「当前投影」下的半幅比例满足 aspect。
        // d=0 时等价于 hf = 2·atan(tan(vf/2)·aspect)；d>0 时用二分求角半径（单调区间）。
        public static double Hfov(double vfDeg, double aspect)
        {
            double target = aspect * HalfScale(vfDeg / 2.0);
            double lo = 0.0, hi = 179.0;
            for (int i = 0; i < 48; i++)
            {
                double mid = (lo + hi) / 2.0;
                if (HalfScale(mid / 2.0) < target) lo = mid;
                else hi = mid;
            }
            return (lo + hi) / 2.0;
        }

        // 径向投影半幅尺度：角半径 a（度）→ 图像平面坐标。
        // d=0 时就是 tan(a)，因此旧针孔渲染/标注公式可作为本模型的特例。
        public static double HalfScale(double aDeg)
        {
            double a = Geo.Rad(aDeg), d = NaturalD;
            return (d + 1.0) * Math.Sin(a) / (d + Math.Cos(a));
        }

        // 世界方向 → 4:3 照片/切图的归一化像素位置（fx/fy 均为 0~1，fy 向下）。
        // 相机基向量与 RenderRectilinear 完全一致；Z 是视线前向分量，X 右、Y 上。
        // shift 是移轴量（成像窗口上移）：0 = 对称视场；>0 = 光轴不变、画面取更高的一段。
        public static void PixelFromWorld(double azDeg, double elDeg, double az0Deg, double el0Deg,
                                          double th, double tv, double shift, out double fx, out double fy)
        {
            fx = 0.5; fy = 0.5;
            double az = Geo.Rad(azDeg), el = Geo.Rad(elDeg);
            double a0 = Geo.Rad(az0Deg), e0 = Geo.Rad(el0Deg);
            double dx = Math.Sin(az) * Math.Cos(el), dy = Math.Cos(az) * Math.Cos(el), dz = Math.Sin(el);
            double cp = Math.Cos(a0), sp = Math.Sin(a0), ce = Math.Cos(e0), se = Math.Sin(e0);
            double z = dx * sp * ce + dy * cp * ce + dz * se;
            // 广角画面的角落可能略超过前向半球，但只要 d+z>0 仍可由该投影表示。
            // 原来的 z>0 针孔判据会把合法标注误送到画面中心。
            if (NaturalD + z <= 1e-9) return;
            double x = dx * cp - dy * sp;
            double y = dx * (-sp * se) + dy * (-cp * se) + dz * ce;
            double k = (NaturalD + 1.0) / (NaturalD + z);
            fx = 0.5 + 0.5 * (k * x) / th;
            fy = 0.5 - 0.5 * (k * y) / tv + 0.5 * shift;
        }

        // 针孔逆投影：全景预览的点选/拖动使用（PanoramaRenderer 的渲染也是针孔）。
        public static void WorldFromPixel(double u, double v, double az0Deg, double el0Deg,
                                          double hfDeg, double vfDeg, out double azDeg, out double elDeg)
        {
            double th = Math.Tan(Geo.Rad(hfDeg) / 2), tv = Math.Tan(Geo.Rad(vfDeg) / 2);
            double X = u * th, Y = v * tv;
            double p0 = Geo.Rad(az0Deg), e0 = Geo.Rad(el0Deg);
            double cp = Math.Cos(p0), sp = Math.Sin(p0), ce = Math.Cos(e0), se = Math.Sin(e0);
            double Rx = X * cp - Y * sp * se + sp * ce;
            double Ry = -X * sp - Y * cp * se + cp * ce;
            double Rz = Y * ce + se;
            azDeg = Geo.Wrap360(Geo.Deg(Math.Atan2(Rx, Ry)));
            elDeg = Geo.Clamp(Geo.Deg(Math.Atan2(Rz, Math.Sqrt(Rx * Rx + Ry * Ry))), -89, 89);
        }

        // 径向投影的逆投影：4:3 照片内拖准心时，把像素反算成世界方向。
        // 由 x=(d+1)X/(d+Z)、y=(d+1)Y/(d+Z) 与 X²+Y²+Z²=1 消元得到 Z 的二次方程：
        //   [r²+(d+1)²]Z² + 2dr²Z + d²r²-(d+1)² = 0，取前向根。
        // shift 与 PixelFromWorld 严格互逆：屏幕 v=(1-2fy)+shift 后再参与反投影。
        public static void WorldFromPixelNatural(double u, double v, double az0Deg, double el0Deg,
                                                 double hfDeg, double vfDeg, double shift,
                                                 out double azDeg, out double elDeg)
        {
            double x = u * HalfScale(hfDeg / 2.0), y = (v + shift) * HalfScale(vfDeg / 2.0);
            double d = NaturalD, d1 = d + 1.0;
            double r2 = x * x + y * y;
            double qa = r2 + d1 * d1, qb = 2.0 * d * r2, qc = r2 * d * d - d1 * d1;
            double disc = Math.Max(qb * qb - 4.0 * qa * qc, 0.0);
            double z = (-qb + Math.Sqrt(disc)) / (2.0 * qa);
            double k = (d + z) / d1;
            double X = x * k, Y = y * k;
            double p0 = Geo.Rad(az0Deg), e0 = Geo.Rad(el0Deg);
            double cp = Math.Cos(p0), sp = Math.Sin(p0), ce = Math.Cos(e0), se = Math.Sin(e0);
            double Rx = X * cp - Y * sp * se + z * sp * ce;
            double Ry = -X * sp - Y * cp * se + z * cp * ce;
            double Rz = Y * ce + z * se;
            azDeg = Geo.Wrap360(Geo.Deg(Math.Atan2(Rx, Ry)));
            elDeg = Geo.Clamp(Geo.Deg(Math.Atan2(Rz, Math.Sqrt(Rx * Rx + Ry * Ry))), -89, 89);
        }
    }
}
