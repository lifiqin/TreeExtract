using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;

namespace TreeExtractor
{
    // 选帧精细评分用的候选帧。几何硬约束仍在 PickFrameUtm 中计算，这里只补充
    // 「前景遮挡」和「树所在全景局部区域的清晰度/曝光」两项质量信息。
    class FrameCandidate
    {
        public int Index;
        public double Dh;                 // 相机到树心的水平距离
        public double ElA, ElB, ElT;      // 瞄准点/树底/树顶仰角
        public double AzT, A0;            // 树方位、全景第 0 列方位（含水平修正）
        public double PriorOverlap, Off;  // 经验区域重叠度、偏离相机前方的角度
        public bool FitsPhoto;             // 目标树顶与树底是否落在实际 4:3 投影窗口内
        public int Occ;                   // 视线被前景树遮挡的次数
        public double Q;                  // 综合质量分（越高越好）
    }

    // 选中树的最终选帧结果缓存。取景模式、投影模型或水平校正改变均需重选。
    class RefinedChoice
    {
        public int Index;
        public double Dist, Az, El, Ang, Cal;
        public bool LevelView;
        public double ProjectionD;
    }

    public partial class BackendSession
    {
        readonly Dictionary<int, RefinedChoice> _refinedChoices = new Dictionary<int, RefinedChoice>();
        readonly FrameReservations _frameReservations = new FrameReservations();
        readonly Dictionary<int, List<FrameSeparation.Axis>> _nearbyAxes = new Dictionary<int, List<FrameSeparation.Axis>>();

        FrameSeparation.Axis TreeAxis(UtmTree tree)
        {
            double x, y;
            TrunkAxisUtm(tree, out x, out y);
            return new FrameSeparation.Axis { Id = tree.Id, X = x, Y = y };
        }

        List<FrameSeparation.Axis> NearbyAxes(UtmTree tree)
        {
            List<FrameSeparation.Axis> nearby;
            if (_nearbyAxes.TryGetValue(tree.Id, out nearby)) return nearby;
            var axes = new List<FrameSeparation.Axis>();
            if (_utmForest != null)
                foreach (UtmTree other in _utmForest.Trees)
                    if (other != null) axes.Add(TreeAxis(other));
            nearby = FrameSeparation.Nearby(TreeAxis(tree), axes);
            _nearbyAxes[tree.Id] = nearby;
            return nearby;
        }

        FrameSeparation.Conflict NeighborConflict(UtmTree tree, double[] pose)
        {
            if (tree == null || !CameraPose.IsValid(pose)) return null;
            return FrameSeparation.Find(TreeAxis(tree), NearbyAxes(tree), pose[0], pose[1]);
        }

        // 每组只读取最多 5 帧；若分离视角比原近帧明显模糊/过暗，保留原近帧并警告，
        // 避免仅凭几何分离把用户带到无法辨认的黑图。阈值是启发式，不证明目标身份。
        FrameCandidate RefineFrameChoice(UtmTree t, List<FrameCandidate> cands)
        {
            var separated = new List<FrameCandidate>();
            var nearby = NearbyAxes(t);
            var axis = TreeAxis(t);
            if (nearby.Count > 0)
                foreach (var c in cands)
                {
                    double[] mp;
                    if (TryGetSelectionPose(c.Index, out mp) &&
                        FrameSeparation.Find(axis, nearby, mp[0], mp[1]) == null) separated.Add(c);
                }
            var scores = new HashSet<int>();
            FrameCandidate baseline = ScoreNearFramePool(t, cands, scores);
            FrameCandidate best = baseline;
            if (separated.Count > 0)
            {
                FrameCandidate alternative = ScoreNearFramePool(t, separated, scores);
                const double MaxQualityLoss = 2.0;
                if (alternative.Q > -999 && alternative.Q >= baseline.Q - MaxQualityLoss)
                    best = alternative;
            }
            BackendLog.Write("选帧细化 树" + t.Id
                        + " 最近=" + _frames.Frames[cands[0].Index].Name
                        + " 选定=" + _frames.Frames[best.Index].Name
                        + " 距离=" + best.Dh.ToString("F2") + " q=" + best.Q.ToString("F2")
                        + " 遮挡=" + best.Occ);
            return best;
        }

        FrameCandidate ScoreNearFramePool(UtmTree t, List<FrameCandidate> choices, HashSet<int> scores)
        {
            double minDh = choices[0].Dh;
            var pool = new List<FrameCandidate>();
            foreach (var c in choices)
            {
                if (c.Dh > minDh * 1.3 + 1e-9 || pool.Count >= 5) break;
                pool.Add(c);
            }
            var aim = AimTrunk(t);
            foreach (var c in pool)
            {
                if (!scores.Add(c.Index)) continue;
                double[] mp;
                if (!_metaPose.TryGetValue(_frames.Frames[c.Index].Name, out mp))
                {
                    c.Q = -999;
                    continue;
                }
                c.Occ = CountOcclusion(t, mp, aim, c.Dh);
                c.Q = ScoreFrameQuality(t, c);
            }
            var clear = pool.FindAll(c => c.Occ == 0);
            if (clear.Count > 0) pool = clear;

            var best = pool[0];
            foreach (var c in pool)
                if (c.Q - 1.5 * c.Occ > best.Q - 1.5 * best.Occ) best = c;
            return best;
        }

        // 相机到树干中段的水平射线，与前景树的冠幅圆柱/树干做遮挡检测。
        // 与离线回放同一口径：只统计目标树之前的遮挡，目标树自身不参与。
        int CountOcclusion(UtmTree t, double[] mp, UtmTree aim, double dh)
        {
            if (_utmForest == null || dh < 1e-6) return 0;
            double dx = aim.X - mp[0], dy = aim.Y - mp[1];
            double ux = dx / dh, uy = dy / dh;
            int occ = 0;
            foreach (var o in _utmForest.Trees)
            {
                if (o.Id == t.Id) continue;
                double vx = o.X - mp[0], vy = o.Y - mp[1];
                double along = vx * ux + vy * uy;
                if (along <= 0.4 || along >= dh - 0.4) continue;
                double perp = Math.Abs(vx * uy - vy * ux);
                double r = Math.Max(CrownRadiusOf(o.Id, o.Height) * 0.8, 0.15);
                if (perp > r) continue;
                double zray = mp[2] + (aim.Z - mp[2]) * along / dh;
                if (o.Z - 0.2 <= zray && zray <= o.Z + o.Height) occ++;
            }
            return occ;
        }

        // 读取候选帧的全景源图，只取树所在的局部 ROI 计算清晰度/曝光。
        // 不渲染整张投影图：选帧阶段每组最多读 5 张，结果随后按树缓存。
        double ScoreFrameQuality(UtmTree t, FrameCandidate c)
        {
            string name = _frames.Frames[c.Index].Name;
            using (var bmp = _frames.Load(name))
            {
                if (bmp == null) return -999;
                // 与离线回放一致：先把 5760×2880 缩到 1440×720，再按角度取 ROI
                using (var small = new Bitmap(bmp, new Size(1440, 720)))
                    return RoiQuality(small, t, c);
            }
        }

        double RoiQuality(Bitmap bmp, UtmTree t, FrameCandidate c)
        {
            int W = bmp.Width, H = bmp.Height;
            double cx = Geo.Rad(c.AzT - c.A0) / (2.0 * Math.PI) * W;
            cx %= W;
            if (cx < 0) cx += W;
            double cy = (90.0 - c.ElA) / 180.0 * H;
            double halfAz = Geo.Clamp(Geo.Deg(Math.Atan(CrownRadiusOf(t.Id, t.Height) / c.Dh)), 4.0, 45.0);
            double rw = Math.Max(8.0, halfAz / 360.0 * W);
            double rh = Math.Max(8.0, (c.ElT - c.ElB) / 180.0 * H / 2.0);
            int x0 = (int)(cx - rw), x1 = (int)(cx + rw);
            int y0 = (int)Math.Max(0, cy - rh), y1 = (int)Math.Min(H - 1, cy + rh);
            int stepX = Math.Max(1, (int)Math.Ceiling((x1 - x0 + 1) / 256.0));
            int stepY = Math.Max(1, (int)Math.Ceiling((y1 - y0 + 1) / 256.0));
            int w = (x1 - x0) / stepX + 1, h = (y1 - y0) / stepY + 1;
            if (w < 4 || h < 4) return -999;

            var data = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, bmp.PixelFormat);
            int bpp = Image.GetPixelFormatSize(bmp.PixelFormat) / 8;
            if (bpp < 3) bpp = 3;
            try
            {
                unsafe
                {
                    byte* basePtr = (byte*)data.Scan0;
                    int stride = data.Stride;
                    var gray = new float[h, w];
                    double sum = 0;
                    int over = 0, under = 0;
                    for (int j = 0; j < h; j++)
                    {
                        int sy = y0 + j * stepY;
                        if (sy >= H) sy = H - 1;
                        for (int i = 0; i < w; i++)
                        {
                            int sx = (x0 + i * stepX) % W;
                            if (sx < 0) sx += W;
                            byte* p = basePtr + sy * stride + sx * bpp;
                            float g = 0.114f * p[0] + 0.587f * p[1] + 0.299f * p[2];
                            gray[j, i] = g;
                            sum += g;
                            if (g > 245) over++;
                            if (g < 15) under++;
                        }
                    }
                    double mean = sum / (w * h);
                    double lapSum = 0, lapSum2 = 0;
                    int n = 0;
                    for (int j = 1; j < h - 1; j++)
                        for (int i = 1; i < w - 1; i++)
                        {
                            double lap = -4.0 * gray[j, i] + gray[j - 1, i] + gray[j + 1, i]
                                       + gray[j, i - 1] + gray[j, i + 1];
                            lapSum += lap;
                            lapSum2 += lap * lap;
                            n++;
                        }
                    if (n == 0) return -999;
                    double lapMean = lapSum / n;
                    double variance = lapSum2 / n - lapMean * lapMean;
                    double sharp = Math.Log(1.0 + Math.Max(0.0, variance));
                    double penalty = Math.Max(0.0, (30.0 - mean) / 30.0)
                                   + Math.Max(0.0, (mean - 225.0) / 30.0)
                                   + 2.0 * over / (double)(w * h)
                                   + under / (double)(w * h);
                    return sharp - penalty;
                }
            }
            finally
            {
                bmp.UnlockBits(data);
            }
        }
    }
}
