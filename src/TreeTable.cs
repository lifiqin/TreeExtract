using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace TreeExtractor
{
    // ===== 每棵树对应的最优全景帧及角度解算结果 =====
    public class PanoRow
    {
        public int Id;
        public double TreeX, TreeY, TreeZ, TreeH;
        public string Frame;
        public double Gps;
        public double CamX, CamY, CamZ;
        public double Hz, Slant, Bear, Elev;
        public double Px, Py, Off;
        public double CamYaw, PanoAz;
        public double Omega, Phi, Kappa;
        public double ImuYaw;      // double.NaN = 该时刻无 IMU 数据
        public double MinDist;     // 该树到相机轨迹的最近水平距离
    }

    public class MetaFrame
    {
        public string Name;
        public double Gps, X, Y, Z, Omega, Phi, Kappa, CamYaw, PanoAz;
    }

    // ===== 树心 → 全景帧 的匹配与角度解算 =====
    // 坐标一律用 UTM（X=东, Y=北, Z=高），tree_centers.txt 与 Metashape.txt 同一投影，可直接相减。
    public static class PanoMath
    {
        public const double W = 5760, H = 2880;         // 全景图尺寸（等距柱状投影）
        public const double PanOff = -90.0;             // 全景中心方位 = 相机 +X 轴方位 + PanOff
        public const double R2D = 180.0 / Math.PI;

        static double[,] Mul(double[,] A, double[,] B)
        {
            var C = new double[3, 3];
            for (int i = 0; i < 3; i++)
                for (int j = 0; j < 3; j++)
                {
                    double s = 0;
                    for (int k = 0; k < 3; k++) s += A[i, k] * B[k, j];
                    C[i, j] = s;
                }
            return C;
        }
        static double[] Mul(double[,] A, double[] v)
        {
            return new double[] {
                A[0,0]*v[0] + A[0,1]*v[1] + A[0,2]*v[2],
                A[1,0]*v[0] + A[1,1]*v[1] + A[1,2]*v[2],
                A[2,0]*v[0] + A[2,1]*v[1] + A[2,2]*v[2] };
        }
        static double[,] Rx(double r) { double c = Math.Cos(r), s = Math.Sin(r); return new double[,] { { 1, 0, 0 }, { 0, c, -s }, { 0, s, c } }; }
        static double[,] Ry(double r) { double c = Math.Cos(r), s = Math.Sin(r); return new double[,] { { c, 0, s }, { 0, 1, 0 }, { -s, 0, c } }; }
        static double[,] Rz(double r) { double c = Math.Cos(r), s = Math.Sin(r); return new double[,] { { c, -s, 0 }, { s, c, 0 }, { 0, 0, 1 } }; }

        // Metashape 姿态角(度) → 指定机体轴在世界系中的方位角(度, 自北顺时针)
        static double AxisAz(double omega, double phi, double kappa, double vx, double vy, double vz)
        {
            double[,] R = Mul(Mul(Rx(omega / R2D), Rz(kappa / R2D)), Ry(phi / R2D));
            double[] w = Mul(R, new double[] { vx, vy, vz });
            return Geo.Wrap360(Math.Atan2(w[0], w[1]) * R2D);
        }

        // 读取 Metashape 帧（帧名即 GPS 时间）
        public static List<MetaFrame> LoadMetashape(string path)
        {
            var list = new List<MetaFrame>();
            foreach (var line in File.ReadLines(path))
            {
                var p = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (p.Length < 7) continue;
                if (!p[0].EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)) continue;
                double gps, x, y, z, om, ph, kp;
                if (!double.TryParse(p[0].Substring(0, p[0].Length - 4), NumberStyles.Float, CultureInfo.InvariantCulture, out gps)) continue;
                if (!double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out x)) continue;
                if (!double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out y)) continue;
                if (!double.TryParse(p[3], NumberStyles.Float, CultureInfo.InvariantCulture, out z)) continue;
                if (!double.TryParse(p[4], NumberStyles.Float, CultureInfo.InvariantCulture, out om)) continue;
                if (!double.TryParse(p[5], NumberStyles.Float, CultureInfo.InvariantCulture, out ph)) continue;
                if (!double.TryParse(p[6], NumberStyles.Float, CultureInfo.InvariantCulture, out kp)) continue;
                var f = new MetaFrame { Name = p[0], Gps = gps, X = x, Y = y, Z = z, Omega = om, Phi = ph, Kappa = kp };
                f.CamYaw = AxisAz(om, ph, kp, 1, 0, 0);
                f.PanoAz = Geo.Wrap360(f.CamYaw + PanOff);
                list.Add(f);
            }
            list.Sort(delegate (MetaFrame a, MetaFrame b) { return a.Gps.CompareTo(b.Gps); });
            return list;
        }

        // 读取 imgPosList 的第一段（三个镜头槽位中的第一路），取 (Heading+Roll) 作为航向
        // Roll≈±180°、Pitch≈−88° 属传感器万向锁姿态，Heading 不能单独当航向用
        public static void LoadImu(string path, out double[] times, out double[] yaws)
        {
            var t = new List<double>();
            var y = new List<double>();
            double prev = double.MinValue;
            foreach (var line in File.ReadLines(path))
            {
                var p = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (p.Length < 8) continue;
                double tt, roll, hdg;
                if (!double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out tt)) continue;
                if (!double.TryParse(p[5], NumberStyles.Float, CultureInfo.InvariantCulture, out roll)) continue;
                if (!double.TryParse(p[7], NumberStyles.Float, CultureInfo.InvariantCulture, out hdg)) continue;
                if (t.Count > 0 && tt < prev) break;      // 时间回跳 = 进入下一镜头槽位
                prev = tt;
                t.Add(tt);
                y.Add(Geo.Wrap360(hdg + roll));
            }
            times = t.ToArray();
            yaws = y.ToArray();
        }

        // 取最接近时刻 t 的 IMU 航向，超过 tol 秒视为无数据
        public static double ImuAt(double[] times, double[] yaws, double t, double tol)
        {
            if (times == null || times.Length == 0) return double.NaN;
            int lo = 0, hi = times.Length - 1;
            if (t <= times[0]) return (times[0] - t <= tol) ? yaws[0] : double.NaN;
            if (t >= times[hi]) return (t - times[hi] <= tol) ? yaws[hi] : double.NaN;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) / 2;
                if (times[mid] <= t) lo = mid; else hi = mid;
            }
            int j = (t - times[lo] <= times[hi] - t) ? lo : hi;
            return (Math.Abs(times[j] - t) <= tol) ? yaws[j] : double.NaN;
        }

        // 为每棵树挑最优全景帧：水平距离在 [dmin,dmax] 内、且树最接近全景中心（横向偏离最小）
        public static List<PanoRow> Build(List<UtmTree> trees, List<MetaFrame> frames,
                                          double[] imuT, double[] imuY, double dmin, double dmax)
        {
            var rows = new List<PanoRow>();
            foreach (var tr in trees)
            {
                MetaFrame best = null, nearest = null;
                double bestOff = 0, bestHz = 0, bestBear = 0, minD = double.MaxValue;
                foreach (var f in frames)
                {
                    double dE = tr.X - f.X, dN = tr.Y - f.Y;
                    double hz = Geo.Dist2D(dE, dN);
                    if (hz < minD) { minD = hz; nearest = f; }
                    if (hz < dmin || hz > dmax) continue;
                    double brg = Geo.Wrap360(Math.Atan2(dE, dN) * R2D);
                    double off = Geo.Wrap180(brg - f.PanoAz);
                    if (best == null || Math.Abs(off) < Math.Abs(bestOff))
                    { best = f; bestOff = off; bestHz = hz; bestBear = brg; }
                }
                if (best == null)                 // 附近没有合适帧，退回最近的一帧
                {
                    if (nearest == null) continue;
                    best = nearest; bestHz = minD;
                    bestBear = Geo.Wrap360(Math.Atan2(tr.X - nearest.X, tr.Y - nearest.Y) * R2D);
                    bestOff = Geo.Wrap180(bestBear - nearest.PanoAz);
                }
                var r = new PanoRow();
                r.Id = tr.Id;
                r.TreeX = tr.X; r.TreeY = tr.Y; r.TreeZ = tr.Z; r.TreeH = tr.Height;
                r.Frame = best.Name; r.Gps = best.Gps;
                r.CamX = best.X; r.CamY = best.Y; r.CamZ = best.Z;
                r.Omega = best.Omega; r.Phi = best.Phi; r.Kappa = best.Kappa;
                r.CamYaw = best.CamYaw; r.PanoAz = best.PanoAz;
                r.Hz = bestHz; r.Bear = bestBear; r.Off = bestOff;
                // 瞄准树冠中部（树底高程直接瞄会落到草丛里）
                double aimZ = tr.Z + tr.Height * 0.5;
                r.Slant = Math.Sqrt(bestHz * bestHz + (aimZ - best.Z) * (aimZ - best.Z));
                r.Elev = Math.Atan2(aimZ - best.Z, bestHz) * R2D;
                // 等距柱状投影像素：x 相对全景中心偏移角换算后加半幅，y 由仰角换算
                r.Px = Geo.Wrap180(bestBear - best.PanoAz) / 360.0 * W + W / 2.0;
                r.Py = (90.0 - r.Elev) / 180.0 * H;
                r.ImuYaw = ImuAt(imuT, imuY, best.Gps, 0.3);
                r.MinDist = minD;
                rows.Add(r);
            }
            return rows;
        }
    }

    // 纯数据导出，与窗口和控件无关。
    internal static class TreeTableExport
    {
        internal static readonly string[] Headers = {
            "树号","树心X(东)","树心Y(北)","树心Z(高程)","树高(m)","全景图","帧时间(GPS)",
            "相机X","相机Y","相机Z","水平距离(m)","斜距(m)","方位角(°)","仰角(°)",
            "全景像素X","全景像素Y","横向偏离(°)","相机朝向(°)","全景中心方位(°)",
            "Metashape_Omega","Metashape_Phi","Metashape_Kappa","IMU航向(°)","最近距离(m)" };
        internal static readonly bool[] Numeric = {
            true,true,true,true,true,false,true,
            true,true,true,true,true,true,true,
            true,true,true,true,true,
            true,true,true,true,true };

        internal static object[] CellsOf(PanoRow r)
        {
            return new object[] {
                (double)r.Id, r.TreeX, r.TreeY, r.TreeZ, r.TreeH, r.Frame, r.Gps,
                r.CamX, r.CamY, r.CamZ, r.Hz, r.Slant, r.Bear, r.Elev, r.Px, r.Py, r.Off,
                r.CamYaw, r.PanoAz, r.Omega, r.Phi, r.Kappa,
                double.IsNaN(r.ImuYaw) ? (object)null : r.ImuYaw, r.MinDist };
        }

        internal static void WriteCsv(string path, List<string> headers, List<PanoRow> rows)
        {
            using (var w = new StreamWriter(path, false, new UTF8Encoding(true)))
            {
                w.WriteLine(string.Join(",", headers.ToArray()));
                foreach (var r in rows)
                {
                    var v = CellsOf(r);
                    var s = new string[v.Length];
                    for (int i = 0; i < v.Length; i++)
                    {
                        if (v[i] == null) { s[i] = ""; continue; }
                        double d;
                        if (v[i] is double) { d = (double)v[i]; s[i] = double.IsNaN(d) ? "" : d.ToString("0.###", CultureInfo.InvariantCulture); }
                        else s[i] = v[i].ToString();
                        if (s[i].IndexOf(',') >= 0 || s[i].IndexOf('"') >= 0)
                            s[i] = "\"" + s[i].Replace("\"", "\"\"") + "\"";
                    }
                    w.WriteLine(string.Join(",", s));
                }
            }
        }

        const string CT = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n"
            + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
            + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
            + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
            + "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
            + "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
            + "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>"
            + "</Types>";

        const string RELS = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n"
            + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
            + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>"
            + "</Relationships>";

        const string WB = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n"
            + "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" "
            + "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">"
            + "<sheets><sheet name=\"树心全景对照表\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>";

        const string WBRELS = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n"
            + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
            + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>"
            + "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>"
            + "</Relationships>";

        const string STYLES = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n"
            + "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">"
            + "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"等线\"/></font>"
            + "<font><b/><sz val=\"11\"/><name val=\"等线\"/></font></fonts>"
            + "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>"
            + "<borders count=\"1\"><border/></borders>"
            + "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>"
            + "<cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>"
            + "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/></cellXfs>"
            + "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>"
            + "</styleSheet>";

        internal static void WriteXlsx(string path, List<string> headers, List<PanoRow> rows)
        {
            var sb = new StringBuilder();
            sb.Append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n");
            sb.Append("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>");
            sb.Append("<row r=\"1\">");
            for (int c = 0; c < headers.Count; c++)
                sb.Append("<c r=\"").Append(ColRef(c)).Append("1\" s=\"1\" t=\"inlineStr\"><is><t>")
                  .Append(XmlEsc(headers[c])).Append("</t></is></c>");
            sb.Append("</row>");

            for (int i = 0; i < rows.Count; i++)
            {
                var v = CellsOf(rows[i]);
                int rn = i + 2;
                sb.Append("<row r=\"").Append(rn).Append("\">");
                for (int c = 0; c < v.Length; c++)
                {
                    string cell = ColRef(c) + rn;
                    if (v[c] == null) { sb.Append("<c r=\"").Append(cell).Append("\"/>"); continue; }
                    if (v[c] is double && Numeric[c])
                    {
                        double d = (double)v[c];
                        if (double.IsNaN(d)) sb.Append("<c r=\"").Append(cell).Append("\"/>");
                        else sb.Append("<c r=\"").Append(cell).Append("\"><v>")
                                 .Append(d.ToString("R", CultureInfo.InvariantCulture)).Append("</v></c>");
                    }
                    else
                    {
                        sb.Append("<c r=\"").Append(cell).Append("\" t=\"inlineStr\"><is><t>")
                          .Append(XmlEsc(v[c].ToString())).Append("</t></is></c>");
                    }
                }
                sb.Append("</row>");
            }
            sb.Append("</sheetData></worksheet>");

            using (var fs = File.Create(path))
            using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
            {
                Put(zip, "[Content_Types].xml", CT);
                Put(zip, "_rels/.rels", RELS);
                Put(zip, "xl/workbook.xml", WB);
                Put(zip, "xl/_rels/workbook.xml.rels", WBRELS);
                Put(zip, "xl/styles.xml", STYLES);
                Put(zip, "xl/worksheets/sheet1.xml", sb.ToString());
            }
        }

        static void Put(ZipArchive zip, string name, string content)
        {
            var e = zip.CreateEntry(name, CompressionLevel.Optimal);
            using (var s = e.Open())
            {
                var b = new UTF8Encoding(false).GetBytes(content);
                s.Write(b, 0, b.Length);
            }
        }

        static string ColRef(int idx)
        {
            string s = "";
            idx++;
            while (idx > 0) { int r = (idx - 1) % 26; s = (char)('A' + r) + s; idx = (idx - 1) / 26; }
            return s;
        }

        static string XmlEsc(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length);
            foreach (char c in s)
            {
                if (c == '&') sb.Append("&amp;");
                else if (c == '<') sb.Append("&lt;");
                else if (c == '>') sb.Append("&gt;");
                else if (c == '"') sb.Append("&quot;");
                else if (c == '\'') sb.Append("&apos;");
                else if (c < 32 && c != '\t' && c != '\n' && c != '\r') sb.Append(' ');
                else sb.Append(c);
            }
            return sb.ToString();
        }
    }
}
