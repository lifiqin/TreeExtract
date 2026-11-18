using System;
using System.Drawing;
using System.Drawing.Imaging;

namespace TreeExtractor
{
    /// <summary>
    /// 图像侧树干量测：在全景 ROI 内估计候选轴心列与可见段上下界，
    /// 再把像素反投影为世界角度。水平和垂直校正均与 BackendSession.Photo.cs 同口径。
    /// 暗度、颜色和边缘只是启发式证据，并不能保证识别到的必然是真实树干。
    /// </summary>
    internal static class TrunkObservation
    {
        /// <summary>
        /// 量测入口：输出角度、质量和诊断射线；证据不足时返回 false。
        /// </summary>
        public static bool MeasureEx(Bitmap small, UtmTree t, FrameCandidate c, double[] mp, double cal, double calV,
                                     out TrunkMeasure m)
        {
            return MeasureEx(small, t, c, mp, cal, calV, false, out m);
        }

        /// <summary>
        /// 在普通响应段不可用时，可额外尝试要求双侧边缘连续存在的候选段。
        /// 此分支不改变后续纹理、几何、歧义和风险检查，不能单独证明树干身份。
        /// </summary>
        internal static bool MeasureEx(Bitmap small, UtmTree t, FrameCandidate c, double[] mp,
                                       double cal, double calV, bool useEdgeSegment, out TrunkMeasure m)
        {
            // out 参数先给自洽默认值：异常路径也不留空。
            m = new TrunkMeasure();
            m.Ray = new Ray3();
            m.Ray.O = new Vec3();
            m.Ray.D = new Vec3();
            m.Ray.D.Z = 1.0;

            if (small == null || t == null || c == null || mp == null
                || mp.Length < DualFrameConfig.PoseDofCount) return false;
            if (double.IsNaN(cal) || double.IsInfinity(cal) ||
                double.IsNaN(calV) || double.IsInfinity(calV)) return false;
            int W = small.Width;
            int H = small.Height;
            if (W < DualFrameConfig.RoiSmallMinW || H < DualFrameConfig.RoiSmallMinH) return false;

            // ① ROI 列中心：与 RoiQuality 同一口径 cx = Rad(AzT-A0)/(2π)·W。
            //    c.A0 已含水平修正 cal。此公式 R3 零改动。
            double cx = Geo.Rad(c.AzT - c.A0) / (DualFrameConfig.DenominatorTwo * Math.PI) * W;
            double yTopD = (DualFrameConfig.RightAngleDeg - c.ElT - calV)
                           / DualFrameConfig.DegPerHalfTurn * H;
            double yBotD = (DualFrameConfig.RightAngleDeg - c.ElB - calV)
                           / DualFrameConfig.DegPerHalfTurn * H;
            double lo = Math.Min(yTopD, yBotD);
            double hi = Math.Max(yTopD, yBotD);
            double pad = Math.Max(DualFrameConfig.RoiRowPadMinPx,
                                  DualFrameConfig.RoiRowPadRatio * (hi - lo));
            int y0 = (int)Math.Floor(lo - pad);
            int y1 = (int)Math.Ceiling(hi + pad);
            if (y0 < 0) y0 = 0;
            if (y1 > H - 1) y1 = H - 1;
            if (y1 - y0 < DualFrameConfig.RoiExpandPx)
            {
                y0 = Math.Max(0, y0 - DualFrameConfig.RoiExpandPx);
                y1 = Math.Min(H - 1, y1 + DualFrameConfig.RoiExpandPx);
            }
            if (y1 - y0 < DualFrameConfig.RoiMinRowsPx) return false;

            // B1：ROI 半宽收紧到 [3°, 20°]，消除近树 50°+ 窗口混入多树干/阴影。
            double winDeg = Geo.Clamp(
                DualFrameConfig.RoiHalfWidthRatio * Math.Abs(c.ElT - c.ElB),
                DualFrameConfig.RoiMinWinDeg, DualFrameConfig.RoiMaxWinDeg);
            int rw = (int)Math.Ceiling(winDeg / DualFrameConfig.DegPerTurn * W);
            if (rw < DualFrameConfig.RoiMinHalfWidthPx) rw = DualFrameConfig.RoiMinHalfWidthPx;
            int rwMax = (int)(W * DualFrameConfig.RoiMaxHalfWidthRatio);
            if (rw > rwMax) rw = rwMax;
            int x0 = (int)Math.Floor(cx - rw);
            int x1 = (int)Math.Ceiling(cx + rw);
            int cols = x1 - x0 + 1;
            int rows = y1 - y0 + 1;
            if (cols < DualFrameConfig.RoiMinColsPx || rows < DualFrameConfig.RoiMinRowsPx)
                return false;

            // ② 采样 ROI：灰度 + 暗度 + 偏褐程度（树干 vs 亮绿/天空背景）。
            //    LockBits 采样与全景拼缝列环绕 R3 零改动。
            double[] gray = new double[cols * rows];
            double[] dark = new double[cols * rows];
            double[] brown = new double[cols * rows];
            BitmapData data = null;
            try
            {
                data = small.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, small.PixelFormat);
                int bpp = Image.GetPixelFormatSize(small.PixelFormat) / DualFrameConfig.BitsPerByte;
                // 只接受常见的 8 位 BGR/BGRA 通道；索引色和 16 位通道不能按此布局读取。
                if (bpp != DualFrameConfig.PixelBytesBgr && bpp != DualFrameConfig.PixelBytesBgra)
                    return false;
                unsafe
                {
                    byte* basePtr = (byte*)data.Scan0;
                    int stride = data.Stride;
                    for (int j = 0; j < rows; j++)
                    {
                        int sy = y0 + j;
                        if (sy < 0) sy = 0;
                        if (sy > H - 1) sy = H - 1;
                        for (int i = 0; i < cols; i++)
                        {
                            int sx = (x0 + i) % W;
                            if (sx < 0) sx += W;   // 全景拼缝：列环绕
                            byte* p = basePtr + sy * stride + sx * bpp;
                            double B = p[0], G = p[1], R = p[2];
                            double g = DualFrameConfig.GrayB * B
                                     + DualFrameConfig.GrayG * G
                                     + DualFrameConfig.GrayR * R;
                            int k = j * cols + i;
                            gray[k] = g;
                            double dv = (DualFrameConfig.DarkRef - g) / DualFrameConfig.DarkRef;
                            if (dv < 0.0) dv = 0.0;
                            if (dv > 1.0) dv = 1.0;
                            dark[k] = dv;
                            double br = (R - G) / DualFrameConfig.BrownRef;
                            if (br < 0.0) br = 0.0;
                            if (br > 1.0) br = 1.0;
                            brown[k] = br;
                        }
                    }
                }
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                if (data != null)
                {
                    try { small.UnlockBits(data); }
                    catch (Exception) { }
                }
            }

            // ③ 沿行累加「垂直边缘 + 颜色」响应，得到树干响应列剖面。
            double[] col = new double[cols];
            for (int j = 0; j < rows; j++)
            {
                for (int i = 1; i < cols - 1; i++)
                {
                    int k = j * cols + i;
                    double gx = Math.Abs(gray[k + 1] - gray[k - 1]) / DualFrameConfig.GradientNorm;
                    if (gx > DualFrameConfig.GradientCap) gx = DualFrameConfig.GradientCap;
                    col[i] += DualFrameConfig.ResponseWGradient * gx
                            + DualFrameConfig.ResponseWDark * dark[k]
                            + DualFrameConfig.ResponseWBrown * brown[k];
                }
            }
            for (int i = 0; i < cols; i++) col[i] /= rows;

            // B2：中心高斯先验，峰倾向理论树方位 cx（ROI 中心）。
            //     归一化后的列剖面逐列乘 prior，peakIdx 在加权后的 col[] 上取。
            // 保存未加权响应：先验只负责选择候选，不能凭空制造图像对比度。
            double[] rawCol = (double[])col.Clone();
            for (int i = 0; i < cols; i++)
            {
                double half = cols / DualFrameConfig.DenominatorTwo;
                double z = (i - half) / (DualFrameConfig.CenterPriorSigma * half);
                col[i] *= Math.Exp(-DualFrameConfig.GaussianHalf * z * z);
            }

            double[] sorted = new double[cols];
            Array.Copy(col, sorted, cols);
            Array.Sort(sorted);
            double median = sorted[cols / 2];
            int peakIdx = 0;
            double peak = -1.0;
            for (int i = 0; i < cols; i++)
            {
                if (col[i] > peak) { peak = col[i]; peakIdx = i; }
            }
            if (peak <= DualFrameConfig.PeakEps) return false;
            double[] rawSorted = (double[])rawCol.Clone();
            Array.Sort(rawSorted);
            double rawMedian = rawSorted[cols / 2];
            double rawPeak = rawCol[peakIdx];
            double rawContrast = (rawPeak - rawMedian) / (rawPeak + DualFrameConfig.PeakEps);
            if (rawContrast < DualFrameConfig.PeakContrastMin) return false;   // B5：下限保持 0.06
            double contrast = Geo.Clamp(rawContrast / DualFrameConfig.PeakContrastScale, 0.0, 1.0);

            // 峰附近加权质心即树干轴心像素列 u*（绝对列坐标，可能为负或 >W）。
            double thresh = median + DualFrameConfig.PeakCentroidFraction * (peak - median);
            int halfWin = Math.Max(DualFrameConfig.PeakCentroidMinHalfPx,
                                   cols / DualFrameConfig.PeakCentroidHalfDivisor);
            double sw = 0.0, su = 0.0;
            int iFrom = Math.Max(0, peakIdx - halfWin);
            int iTo = Math.Min(cols - 1, peakIdx + halfWin);
            for (int i = iFrom; i <= iTo; i++)
            {
                if (col[i] <= thresh) continue;
                double wgt = col[i] - median;
                if (wgt <= 0.0) continue;
                sw += wgt;
                su += wgt * i;
            }
            if (sw <= 0.0) return false;
            double iStarD = su / sw;
            double uStar = x0 + iStarD;

            // 偏离搜索中心过远时不把人为钳位点伪装成图像观测，交给上层回退。
            double maxOff = DualFrameConfig.UStarMaxRatio * rw;
            double off = Math.Abs(uStar - cx);
            if (off > maxOff) return false;
            double peakOffsetRatio = Geo.Clamp(off / Math.Max(1.0, rw), 0.0, 1.0);

            // ④ 沿 u* 列取最长连续高响应段 → vTop / vBot（R3 零改动）。
            // 在同一观测列估计上下边界，避免横向和纵向来自不同位置。
            int iStar = (int)Math.Round(uStar - x0);
            if (iStar < 0) iStar = 0;
            if (iStar > cols - 1) iStar = cols - 1;
            double[] rowResp = new double[rows];
            for (int j = 0; j < rows; j++)
            {
                int k = j * cols + iStar;
                double gx = 0.0;
                if (iStar > 0 && iStar < cols - 1)
                    gx = Math.Abs(gray[k + 1] - gray[k - 1]) / DualFrameConfig.GradientNorm;
                if (gx > DualFrameConfig.GradientCap) gx = DualFrameConfig.GradientCap;
                rowResp[j] = DualFrameConfig.ResponseWGradient * gx
                           + DualFrameConfig.ResponseWDark * dark[k]
                           + DualFrameConfig.ResponseWBrown * brown[k];
            }
            int bestStart, bestLen;
            if (useEdgeSegment)
            {
                if (!TryEdgeSupportedSegment(gray, cols, rows, iStar, out bestStart, out bestLen))
                    return false;
            }
            else
            {
                double[] rs = new double[rows];
                Array.Copy(rowResp, rs, rows);
                Array.Sort(rs);
                double rMed = rs[rows / 2];
                double rMax = rs[rows - 1];
                double rThresh = rMed + DualFrameConfig.SegmentThresholdFraction * (rMax - rMed);
                int curStart = -1, curLen = 0;
                bestStart = -1; bestLen = 0;
                for (int j = 0; j < rows; j++)
                {
                    if (rowResp[j] > rThresh)
                    {
                        if (curStart < 0) { curStart = j; curLen = 1; }
                        else curLen++;
                    }
                    else if (curStart >= 0)
                    {
                        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
                        curStart = -1;
                        curLen = 0;
                    }
                }
                if (curStart >= 0 && curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
            }
            if (bestStart < 0 || bestLen < DualFrameConfig.SegmentMinLenPx) return false;
            int vTop = y0 + bestStart;
            int vBot = y0 + bestStart + bestLen - 1;

            // B4：quality 四项加权和（对比度 / 段长 / 遮挡 / 峰到中心距离）。
            double segRatio = Geo.Clamp((double)bestLen /
                Math.Max(DualFrameConfig.SegRatioMinRows,
                         DualFrameConfig.SegRatioFullFraction * rows), 0.0, 1.0);
            int occ = c.Occ;
            if (occ < 0) occ = 0;
            double occFactor = Math.Max(0.0, 1.0 - DualFrameConfig.QualityOccPenalty * occ);
            double centerFactor = Math.Exp(-DualFrameConfig.GaussianHalf
                * Math.Pow(off / (DualFrameConfig.CenterPriorSigma * Math.Max(1.0, rw)),
                           DualFrameConfig.DenominatorTwo));
            double quality = Geo.Clamp(
                  DualFrameConfig.QualityWContrast * contrast
                + DualFrameConfig.QualityWSegment * segRatio
                + DualFrameConfig.QualityWOcclusion * occFactor
                + DualFrameConfig.QualityWCenter * centerFactor, 0.0, 1.0);
            if (quality <= 0.0) return false;

            // 反投影：像素 → 世界角，垂直方向扣除渲染时加入的 calV。
            double vMid = DualFrameConfig.GaussianHalf * (vTop + vBot);
            double rawElTop = DualFrameConfig.RightAngleDeg
                              - (vTop / (double)H) * DualFrameConfig.DegPerHalfTurn - calV;
            double rawElBot = DualFrameConfig.RightAngleDeg
                              - (vBot / (double)H) * DualFrameConfig.DegPerHalfTurn - calV;
            // 全景极点附近高度换算病态；不能用钳出来的 ±85° 伪装可靠观测。
            if (Math.Abs(rawElTop) >= DualFrameConfig.ElClampDeg ||
                Math.Abs(rawElBot) >= DualFrameConfig.ElClampDeg) return false;
            double elPix = Geo.Clamp(
                DualFrameConfig.RightAngleDeg - (vMid / (double)H) * DualFrameConfig.DegPerHalfTurn - calV,
                -DualFrameConfig.ElClampDeg, DualFrameConfig.ElClampDeg);
            double azPix = Geo.Wrap360(c.A0 + (uStar / (double)W) * DualFrameConfig.DegPerTurn);
            double azR = Geo.Rad(azPix);
            double elR = Geo.Rad(elPix);
            m.Ray.O = new Vec3 { X = mp[0], Y = mp[1], Z = mp[2] };
            m.Ray.D = new Vec3
            {
                X = Math.Cos(elR) * Math.Sin(azR),
                Y = Math.Cos(elR) * Math.Cos(azR),
                Z = Math.Sin(elR)
            };

            // zBot/zTop：沿该射线在水平距离 c.Dh 处换算成相对树底 t.Z 的高度（R3 零改动）。
            double dh = Math.Max(DualFrameConfig.DhFloorM, c.Dh);
            double elTop = rawElTop;
            double elBot = rawElBot;
            m.ZTop = mp[2] + dh * Math.Tan(Geo.Rad(elTop)) - t.Z;
            m.ZBot = mp[2] + dh * Math.Tan(Geo.Rad(elBot)) - t.Z;

            // B6：扩展输出。
            m.AzPix = azPix;
            m.ElPix = elPix;
            m.ElTop = elTop;
            m.ElBot = elBot;
            m.Quality = quality;
            m.PeakContrast = contrast;
            m.PeakOffsetRatio = peakOffsetRatio;
            return true;
        }

        /// <summary>
        /// 树干占据 ROI 大部分行时，行响应中位数会落在树干本身而切碎真实可见段。
        /// 使用固定的、符号相反的双侧边缘寻找连续段；每行都须各自达到边缘强度。
        /// 不跨缺口拼接，以免把被遮挡的中段标成可见。
        /// </summary>
        internal static bool TryEdgeSupportedSegment(double[] gray, int cols, int rows, int center,
                                                     out int start, out int length)
        {
            start = -1;
            length = 0;
            int radius = DualFrameConfig.AppearanceEdgeRadiusPx;
            int leftStart = Math.Max(1, center - radius);
            int rightEnd = Math.Min(cols - 2, center + radius);
            if (leftStart >= center || rightEnd <= center) return false;

            var gradients = new double[cols];
            for (int j = 0; j < rows; j++)
                for (int i = leftStart; i <= rightEnd; i++)
                    gradients[i] += (gray[j * cols + i + 1] - gray[j * cols + i - 1]) * 0.5 / rows;

            int left = -1, right = -1;
            double bestScore = 0.0;
            for (int l = leftStart; l <= center; l++)
            {
                for (int r = center; r <= rightEnd; r++)
                {
                    if (r - l < DualFrameConfig.AppearanceMinWidthPx || gradients[l] * gradients[r] >= 0.0)
                        continue;
                    double strength = Math.Min(Math.Abs(gradients[l]), Math.Abs(gradients[r]));
                    if (strength < DualFrameConfig.AppearanceMinEdgeGradient) continue;
                    double displacement = Math.Abs((l + r) * 0.5 - center);
                    double score = strength / (1.0 + displacement / radius);
                    if (score > bestScore) { bestScore = score; left = l; right = r; }
                }
            }
            if (left < 0) return false;

            int currentStart = -1, currentLength = 0;
            for (int j = 0; j < rows; j++)
            {
                int row = j * cols;
                double edgeLeft = (gray[row + left + 1] - gray[row + left - 1]) * 0.5;
                double edgeRight = (gray[row + right + 1] - gray[row + right - 1]) * 0.5;
                bool supported = edgeLeft * gradients[left] > 0.0 && edgeRight * gradients[right] > 0.0 &&
                    Math.Abs(edgeLeft) >= DualFrameConfig.AppearanceMinEdgeGradient &&
                    Math.Abs(edgeRight) >= DualFrameConfig.AppearanceMinEdgeGradient;
                if (supported)
                {
                    if (currentStart < 0) currentStart = j;
                    currentLength++;
                }
                else
                {
                    if (currentLength > length) { start = currentStart; length = currentLength; }
                    currentStart = -1; currentLength = 0;
                }
            }
            if (currentLength > length) { start = currentStart; length = currentLength; }
            return length >= DualFrameConfig.AppearanceMinRows;
        }

        /// <summary>
        /// R2 旧签名薄包装：保证遗留调用不破；R3 起 Prepare 不再使用它。
        /// </summary>
        public static bool Measure(Bitmap small, UtmTree t, FrameCandidate c, double[] mp, double cal,
                                   out Ray3 ray, out double zBot, out double zTop, out double quality)
        {
            TrunkMeasure m;
            bool ok = MeasureEx(small, t, c, mp, cal, 0.0, out m);
            ray = m.Ray;
            zBot = m.ZBot;
            zTop = m.ZTop;
            quality = m.Quality;
            return ok;
        }
    }
}
