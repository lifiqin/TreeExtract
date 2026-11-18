using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace TreeExtractor
{
    public class Pose
    {
        public double GPS, Longitude, Latitude, HEll, Roll, Pitch, Heading;
    }
    public class FrameInfo
    {
        public double Gps;
        public string Name;
    }
    public static class Geo
    {
        const double A = 6378137.0;
        const double F = 1.0 / 298.257223563;
        const double E2 = 2 * F - F * F;
        public static double Rad(double d) { return d * Math.PI / 180.0; }
        public static double Deg(double r) { return r * 180.0 / Math.PI; }
        public static double Wrap360(double x) { x = x % 360.0; if (x < 0) x += 360.0; return x; }
        public static double Wrap180(double x) { x = x % 360.0; if (x > 180) x -= 360; if (x < -180) x += 360; return x; }
        // 把 v 钳到 [lo,hi]（lo>hi 时以 hi 为准，调用处均为「先保底再封顶」语义）
        public static double Clamp(double v, double lo, double hi) { return Math.Min(Math.Max(v, lo), hi); }
        public static double Dist2D(double a, double b) { return Math.Sqrt(a * a + b * b); }
        // 由东北高差算方位角(从北顺时针0~360)/仰角/直线距离——树相对相机的几何核心
        public static void AzElDist(double dE, double dN, double dU,
                                    out double bearing, out double elev, out double dist)
        {
            double hz = Dist2D(dE, dN);
            dist = Math.Sqrt(dE * dE + dN * dN + dU * dU);
            bearing = Wrap360(Deg(Math.Atan2(dE, dN)));
            if (hz < 1e-6) elev = (dU >= 0) ? 90 : -90;
            else elev = Deg(Math.Atan2(dU, hz));
        }
        // 大地坐标(WGS84) → ECEF（地心直角坐标）
        static void EcefFromGeo(double lat, double lon, double h, out double x, out double y, out double z)
        {
            double latr = Rad(lat), lonr = Rad(lon);
            double sl = Math.Sin(latr), cl = Math.Cos(latr);
            double sn = Math.Sin(lonr), cn = Math.Cos(lonr);
            double Nr = A / Math.Sqrt(1 - E2 * sl * sl);
            x = (Nr + h) * cl * cn;
            y = (Nr + h) * cl * sn;
            z = (Nr * (1 - E2) + h) * sl;
        }

        // 相对原点(0)的 ENU 偏移 → 目标点的大地坐标（纬度迭代收敛，无需迭代高度）
        public static void GeoFromENU(double lat0, double lon0, double h0, double E, double N, double U,
                                      out double lat, out double lon, out double h)
        {
            double latr = Rad(lat0), lonr = Rad(lon0);
            double sl0 = Math.Sin(latr), cl0 = Math.Cos(latr);
            double sn0 = Math.Sin(lonr), cn0 = Math.Cos(lonr);
            double x0, y0, z0;
            EcefFromGeo(lat0, lon0, h0, out x0, out y0, out z0);
            // ENU 偏移 → ECEF 偏移（旋转矩阵的逆）
            double dx = -sn0 * E - sl0 * cn0 * N + cl0 * cn0 * U;
            double dy = cn0 * E - sl0 * sn0 * N + cl0 * sn0 * U;
            double dz = cl0 * N + sl0 * U;
            double x = x0 + dx, y = y0 + dy, z = z0 + dz;
            double p = Math.Sqrt(x * x + y * y);
            double la = latr, lo = Math.Atan2(y, x), hh = 0;
            for (int i = 0; i < 12; i++)
            {
                double s = Math.Sin(la);
                double Nn = A / Math.Sqrt(1 - E2 * s * s);
                hh = p / Math.Cos(la) - Nn;
                la = Math.Atan(z / (p * (1 - E2 * Nn / (Nn + hh))));
            }
            lat = Deg(la); lon = Deg(lo); h = hh;
        }
    }

    // UTM 坐标下的树心数据（直接从 xlsx 导出）
    public class UtmTree
    {
        public int Id;
        public double X, Y, Z;   // UTM 坐标 (东, 北, 高)，单位米
        public double Height;     // 树高（米）
        public string Species;    // 树种
    }

    public class UtmForest
    {
        public List<UtmTree> Trees = new List<UtmTree>();
        public bool Load(string path)
        {
            Trees.Clear();
            foreach (var line in File.ReadLines(path))
            {
                var parts = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5) continue;
                int id; double x, y, z, h;
                if (!int.TryParse(parts[0], out id)) continue;
                if (!double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out x)) continue;
                if (!double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out y)) continue;
                if (!double.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out z)) continue;
                if (!double.TryParse(parts[4], NumberStyles.Float, CultureInfo.InvariantCulture, out h)) continue;
                string sp = parts.Length >= 6 ? parts[5] : "";
                Trees.Add(new UtmTree { Id = id, X = x, Y = y, Z = z, Height = h, Species = sp });
            }
            return Trees.Count > 0;
        }

        // 计算树相对相机的方位角/仰角/距离（UTM 直接算，无需转换）
        public static void TreeAzim(UtmTree t, double camX, double camY, double camZ,
                                    out double bearing, out double elev, out double dist)
        {
            TreeAzim(t.X, t.Y, t.Z, camX, camY, camZ, out bearing, out elev, out dist);
        }

        // 同上，但目标点用任意 UTM 坐标（树底/树顶/树冠左右缘等取点都走这里）
        public static void TreeAzim(double x, double y, double z,
                                    double camX, double camY, double camZ,
                                    out double bearing, out double elev, out double dist)
        {
            Geo.AzElDist(x - camX, y - camY, z - camZ, out bearing, out elev, out dist);
        }
    }

    public class PoseIndex
    {
        public List<Pose> Poses;
        public PoseIndex(string path)
        {
            Poses = new List<Pose>();
            double previous = double.NegativeInfinity;
            int lineNumber = 0;
            foreach (var line in File.ReadLines(path))
            {
                lineNumber++;
                var parts = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 0) continue;
                double d;
                if (!double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out d)) continue;
                if (double.IsNaN(d) || double.IsInfinity(d) || parts.Length < 8)
                    throw new InvalidDataException("位姿文件第 " + lineNumber + " 行无效。");
                // 与 PanoMath.LoadImu 一致：时间回跳表示进入下一路镜头槽位。
                if (d < previous) break;
                previous = d;
                Poses.Add(new Pose
                {
                    GPS = d,
                    Longitude = P(parts[2], lineNumber),
                    Latitude = P(parts[3], lineNumber),
                    HEll = P(parts[4], lineNumber),
                    Roll = P(parts[5], lineNumber),
                    Pitch = P(parts[6], lineNumber),
                    Heading = P(parts[7], lineNumber)
                });
            }
        }
        static double P(string s, int lineNumber)
        {
            double value;
            if (!double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value) ||
                double.IsNaN(value) || double.IsInfinity(value))
                throw new InvalidDataException("位姿文件第 " + lineNumber + " 行含无效数字。");
            return value;
        }
        public Pose GetAt(double t)
        {
            var ps = Poses;
            if (ps.Count == 0) return null;
            if (t <= ps[0].GPS) return ps[0];
            if (t >= ps[ps.Count - 1].GPS) return ps[ps.Count - 1];
            int lo = 0, hi = ps.Count - 1;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) / 2;
                if (ps[mid].GPS <= t) lo = mid; else hi = mid;
            }
            double dt = ps[hi].GPS - ps[lo].GPS;
            if (Math.Abs(dt) < 1e-9) return ps[lo];
            double w = (t - ps[lo].GPS) / dt;
            return new Pose
            {
                GPS = t,
                Longitude = L(ps[lo].Longitude, ps[hi].Longitude, w),
                Latitude = L(ps[lo].Latitude, ps[hi].Latitude, w),
                HEll = L(ps[lo].HEll, ps[hi].HEll, w),
                Roll = L(ps[lo].Roll, ps[hi].Roll, w),
                Pitch = L(ps[lo].Pitch, ps[hi].Pitch, w),
                Heading = Geo.Wrap360(ps[lo].Heading + Geo.Wrap180(ps[hi].Heading - ps[lo].Heading) * w)
            };
        }
        static double L(double a, double b, double w) { return a + (b - a) * w; }
    }
}
