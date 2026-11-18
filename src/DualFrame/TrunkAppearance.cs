using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;

namespace TreeExtractor
{
    /// <summary>
    /// 双帧外观证据：提取多个可能的垂直树干，并在相同世界高度比较亮度纹理。
    /// 它不能识别树的语义身份；几何、遮挡或纹理不足时由调用者回退。
    /// </summary>
    internal static class TrunkAppearance
    {
        /// <summary>多中心搜索复用同一帧位图；输出去重的、具有双侧边缘的候选。</summary>
        public static List<TrunkMeasure> Candidates(Bitmap image, UtmTree tree, FrameCandidate candidate,
                                                     double[] pose, double cal, double calV)
        {
            var results = new List<TrunkMeasure>();
            if (image == null || tree == null || candidate == null || pose == null) return results;
            double halfWindow = Geo.Clamp(DualFrameConfig.RoiHalfWidthRatio *
                Math.Abs(candidate.ElT - candidate.ElB), DualFrameConfig.RoiMinWinDeg,
                DualFrameConfig.RoiMaxWinDeg);
            int[] offsets = { 0, -1, 1, -2, 2 };
            for (int k = 0; k < offsets.Length && results.Count < DualFrameConfig.MaxObservationCandidates; k++)
            {
                var shifted = new FrameCandidate {
                    Index = candidate.Index, Dh = candidate.Dh, ElA = candidate.ElA,
                    ElB = candidate.ElB, ElT = candidate.ElT,
                    AzT = Geo.Wrap360(candidate.AzT + offsets[k] *
                        DualFrameConfig.ObservationShiftFraction * halfWindow),
                    A0 = candidate.A0, Occ = candidate.Occ
                };
                TrunkMeasure m;
                bool observed = TrunkObservation.MeasureEx(image, tree, shifted, pose, cal, calV, out m) &&
                                AttachSignature(image, candidate.A0, calV, ref m);
                if (!observed && DualFrameExperimentOptions.EdgeCandidateEnabled)
                {
                    // 仅离线实验启用：仍要求每行双侧边缘连续，后续验真门槛不变。
                    observed = TrunkObservation.MeasureEx(image, tree, shifted, pose, cal, calV, true, out m) &&
                               AttachSignature(image, candidate.A0, calV, ref m);
                }
                if (!observed) continue;
                if (Math.Abs(Geo.Wrap180(m.AzPix - candidate.AzT)) >
                    DualFrameConfig.ObservationMaxSearchDeg) continue;
                bool duplicate = false;
                for (int i = 0; i < results.Count; i++)
                {
                    if (Math.Abs(Geo.Wrap180(results[i].AzPix - m.AzPix)) <=
                        DualFrameConfig.ObservationDuplicateDeg)
                    {
                        if (m.Quality > results[i].Quality) results[i] = m;
                        duplicate = true;
                        break;
                    }
                }
                if (!duplicate) results.Add(m);
            }
            return results;
        }

        static bool AttachSignature(Bitmap image, double azimuthOrigin, double calV, ref TrunkMeasure m)
        {
            int width = image.Width, height = image.Height;
            int yTop = (int)Math.Round((90.0 - m.ElTop - calV) * height / 180.0);
            int yBottom = (int)Math.Round((90.0 - m.ElBot - calV) * height / 180.0);
            yTop = Math.Max(0, Math.Min(height - 1, yTop));
            yBottom = Math.Max(0, Math.Min(height - 1, yBottom));
            int rows = yBottom - yTop + 1;
            if (rows < DualFrameConfig.AppearanceMinRows) return false;
            double pixel = Geo.Wrap360(m.AzPix - azimuthOrigin) * width / 360.0;
            int center = (int)Math.Round(pixel);
            int radius = DualFrameConfig.AppearanceEdgeRadiusPx;
            int columns = 2 * radius + 3;
            var samples = new float[rows, columns];
            BitmapData data = null;
            try
            {
                data = image.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly,
                                      image.PixelFormat);
                int bpp = Image.GetPixelFormatSize(image.PixelFormat) / 8;
                if (bpp < 3) return false;
                unsafe
                {
                    byte* origin = (byte*)data.Scan0;
                    for (int y = 0; y < rows; y++)
                    {
                        byte* line = origin + (yTop + y) * data.Stride;
                        for (int x = 0; x < columns; x++)
                        {
                            int column = (center - radius - 1 + x) % width;
                            if (column < 0) column += width;
                            byte* p = line + column * bpp;
                            samples[y, x] = (float)(DualFrameConfig.GrayB * p[0] +
                                DualFrameConfig.GrayG * p[1] + DualFrameConfig.GrayR * p[2]);
                        }
                    }
                }
            }
            finally
            {
                if (data != null) image.UnlockBits(data);
            }

            // 树干应有左右方向相反的边缘；只凭深色的单列和中心先验不够。
            var gradient = new double[columns];
            for (int x = 1; x < columns - 1; x++)
            {
                for (int y = 0; y < rows; y++)
                    gradient[x] += (samples[y, x + 1] - samples[y, x - 1]) * 0.5;
                gradient[x] /= rows;
            }
            int bestLeft = -1, bestRight = -1;
            double bestScore = 0.0;
            for (int left = 1; left <= radius + 1; left++)
            {
                for (int right = radius + 1; right < columns - 1; right++)
                {
                    int span = right - left;
                    if (span < DualFrameConfig.AppearanceMinWidthPx || gradient[left] * gradient[right] >= 0.0)
                        continue;
                    double strength = Math.Min(Math.Abs(gradient[left]), Math.Abs(gradient[right]));
                    if (strength < DualFrameConfig.AppearanceMinEdgeGradient) continue;
                    double displacement = Math.Abs((left + right) * 0.5 - (radius + 1));
                    double score = strength / (1.0 + displacement / radius);
                    if (score > bestScore) { bestScore = score; bestLeft = left; bestRight = right; }
                }
            }
            if (bestLeft < 0) return false;
            int consistent = 0;
            for (int y = 0; y < rows; y++)
            {
                double left = (samples[y, bestLeft + 1] - samples[y, bestLeft - 1]) * 0.5;
                double right = (samples[y, bestRight + 1] - samples[y, bestRight - 1]) * 0.5;
                if (left * gradient[bestLeft] > 0.0 && right * gradient[bestRight] > 0.0) consistent++;
            }
            if (consistent < rows * DualFrameConfig.AppearanceMinConsistentRows) return false;

            double offset = (bestLeft + bestRight) * 0.5 - (radius + 1);
            // 两侧边缘是以整数像素 center 采样的，不能再把原始小数偏移叠加一次。
            double refinedPixel = center + offset;
            m.AzPix = Geo.Wrap360(azimuthOrigin + refinedPixel * 360.0 / width);
            m.WidthDeg = (bestRight - bestLeft) * 360.0 / width;
            double azRad = Geo.Rad(m.AzPix), elRad = Geo.Rad(m.ElPix);
            m.Ray.D = new Vec3 { X = Math.Cos(elRad) * Math.Sin(azRad),
                                 Y = Math.Cos(elRad) * Math.Cos(azRad), Z = Math.Sin(elRad) };
            var profile = new float[rows];
            int middle = (bestLeft + bestRight) / 2;
            int half = Math.Max(0, (bestRight - bestLeft) / 5);
            for (int y = 0; y < rows; y++)
            {
                double sum = 0.0;
                int count = 0;
                for (int x = middle - half; x <= middle + half; x++) { sum += samples[y, x]; count++; }
                profile[y] = (float)(sum / count);
            }
            m.GrayProfile = profile;
            return true;
        }

        /// <summary>只比较两视角都可见的同一世界高度段，不把评分称为识别概率。</summary>
        public static bool Agree(TrunkMeasure a, TrunkMeasure b, double[] poseA, double[] poseB,
                                 double distanceA, double distanceB, double treeZ,
                                 double low, double high, out double correlation, out string status)
        {
            correlation = double.NaN;
            status = "missing_profile";
            if (a.GrayProfile == null || b.GrayProfile == null || poseA == null || poseB == null ||
                a.GrayProfile.Length < DualFrameConfig.AppearanceMinRows ||
                b.GrayProfile.Length < DualFrameConfig.AppearanceMinRows) return false;
            status = "insufficient_overlap";
            if (high - low < DualFrameConfig.AppearanceMinHeightM) return false;
            double widthA = distanceA * Math.Tan(Geo.Rad(a.WidthDeg));
            double widthB = distanceB * Math.Tan(Geo.Rad(b.WidthDeg));
            status = "width_mismatch";
            if (!Finite(widthA) || !Finite(widthB) ||
                Math.Min(widthA, widthB) < DualFrameConfig.AppearanceMinWidthM ||
                Math.Max(widthA, widthB) > DualFrameConfig.AppearanceMaxWidthM ||
                Math.Max(widthA, widthB) / Math.Min(widthA, widthB) > DualFrameConfig.AppearanceMaxWidthRatio)
                return false;
            int count = DualFrameConfig.AppearanceHeightSamples;
            var xa = new double[count];
            var xb = new double[count];
            double sumA = 0.0, sumB = 0.0;
            status = "projection_error";
            for (int i = 0; i < count; i++)
            {
                double z = low + (high - low) * i / (count - 1.0) + treeZ;
                double elA = Geo.Deg(Math.Atan2(z - poseA[2], distanceA));
                double elB = Geo.Deg(Math.Atan2(z - poseB[2], distanceB));
                if (!Sample(a, elA, out xa[i]) || !Sample(b, elB, out xb[i])) return false;
                sumA += xa[i]; sumB += xb[i];
            }
            double meanA = sumA / count, meanB = sumB / count;
            // 天空亮、地面暗等共同线性坡度不是树皮纹理：先逐视角去趋势。
            double center = (count - 1.0) * 0.5, xx = 0.0, slopeA = 0.0, slopeB = 0.0;
            for (int i = 0; i < count; i++)
            {
                double x = i - center;
                xx += x * x; slopeA += x * (xa[i] - meanA); slopeB += x * (xb[i] - meanB);
            }
            slopeA /= xx; slopeB /= xx;
            double cov = 0.0, varA = 0.0, varB = 0.0;
            for (int i = 0; i < count; i++)
            {
                double da = xa[i] - meanA - slopeA * (i - center);
                double db = xb[i] - meanB - slopeB * (i - center);
                xa[i] = da; xb[i] = db;
                cov += da * db; varA += da * da; varB += db * db;
            }
            status = "insufficient_texture";
            if (Math.Sqrt(varA / count) < DualFrameConfig.AppearanceMinStd ||
                Math.Sqrt(varB / count) < DualFrameConfig.AppearanceMinStd ||
                TextureTurns(xa) < DualFrameConfig.AppearanceMinTextureTurns ||
                TextureTurns(xb) < DualFrameConfig.AppearanceMinTextureTurns) return false;
            correlation = cov / Math.Sqrt(varA * varB);
            status = Finite(correlation) && correlation >= DualFrameConfig.AppearanceMinCorrelation
                ? "matched" : "correlation_low";
            return status == "matched";
        }

        // 防止单一阶跃或缓慢照明变化被误当作可对应的细节。
        static int TextureTurns(double[] values)
        {
            int turns = 0, previousSign = 0;
            for (int i = 1; i < values.Length; i++)
            {
                double difference = values[i] - values[i - 1];
                int sign = difference > DualFrameConfig.AppearanceTextureTurnEps ? 1 :
                           difference < -DualFrameConfig.AppearanceTextureTurnEps ? -1 : 0;
                if (sign == 0) continue;
                if (previousSign != 0 && sign != previousSign) turns++;
                previousSign = sign;
            }
            return turns;
        }

        static bool Sample(TrunkMeasure m, double elevation, out double value)
        {
            value = 0.0;
            double range = m.ElTop - m.ElBot;
            if (!Finite(range) || range <= 0.0) return false;
            double index = (m.ElTop - elevation) / range * (m.GrayProfile.Length - 1);
            if (index < -1e-6 || index > m.GrayProfile.Length - 1 + 1e-6) return false;
            index = Geo.Clamp(index, 0.0, m.GrayProfile.Length - 1);
            int lo = (int)Math.Floor(index), hi = Math.Min(lo + 1, m.GrayProfile.Length - 1);
            value = m.GrayProfile[lo] + (m.GrayProfile[hi] - m.GrayProfile[lo]) * (index - lo);
            return Finite(value);
        }

        static bool Finite(double value) { return !double.IsNaN(value) && !double.IsInfinity(value); }
    }
}
