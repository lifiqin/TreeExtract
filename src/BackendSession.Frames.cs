using System;
using System.Collections.Generic;
using System.Drawing;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        void PickFrame(double bearing, out FrameInfo fi, out Pose pose)
        {
            FrameInfo best = null; Pose bestPose = null;
            double bestScore = double.MaxValue;
            double cal = (double)_cal;
            foreach (var f in _frames.Frames)
            {
                var p = _poses.GetAt(f.Gps);
                double pan = Geo.Wrap180(bearing - (PanoRefOf(f.Name, p) + cal));
                // 前镜头中心在 pan≈±180（pan≈0 那一侧是举相机的拍摄者本人），取离 180 的偏差
                double score = 180.0 - Math.Abs(pan);
                if (score < bestScore) { bestScore = score; best = f; bestPose = p; }
            }
            fi = best; pose = bestPose;
        }

        // 示例数据中拍摄者常出现在全景的该方位范围；不是人像检测，也不适用于所有相机。
        // 扩大到 40~135° 是为覆盖示例中伸出旧 45~125° 区域的头部与边缘留余量。
        // 自动优选模式尽量避开该风险先验；严格最近和手动选帧不因该先验擅自换帧。
        const double PhotoPriorLo = 40.0, PhotoPriorHi = 135.0;
        // 主帧与双帧候选使用相同的取景角度上限。
        const double QualityFrameMaxOffDeg = 100.0;
        string _photoRiskState = "unavailable";
        string _photoRiskReason = "没有可定位的照片";

        // 底部4:3照片的垂直视场上限。放宽到 120° 是为了让「很近的高树」也能整棵入框。
        // 照片使用径向球面透视投影（见 Proj.NaturalD）；4:3 水平视场由 Proj.Hfov
        // 根据当前投影参数计算。vf=120° 时 d=0.5 约 142.6°，d=1 约 150.4°。
        // （旧上限 104.8° 时，87号树 2.55m 近帧需 113.3° 装不下，树顶被裁 2px。）
        // PickFrameUtm 估窗口与 UpdateNearestPhoto 渲染必须用同一上限，两处口径才一致。
        const double VF43Max = 120.0;

        // 矫正渲染的视场角钳制上限。径向投影保持 4:3 画幅时，vf=120° 对应的 hf 随 d 改变，
        // 旧的 140° 会把 hf 钳小、导致渲染与标注比例不一致；170° 留足余量，
        // 且半视场角仍小于该投影的奇异区（d=0.5 时约 120°）。
        const double FovMax = 170.0;

        // 树冠幅兜底估算：树心数据只有树高、没有冠幅，按「冠幅直径 ≈ 0.75×树高」估。
        // 仅在 crown.csv 里没有该树时使用（正常情况用点云实测半径，见 CrownRadiusOf）。
        const double CrownWidthRatio = 0.75;

        // 取冠幅最宽处的高度比例（树冠中部），用于取树框的左右边缘点
        const double CrownWidthZ = 0.70;

        // 树框用的冠幅半径(m)：优先点云实测值(crown.csv 的 Rcw)，缺该树时退回 0.375×树高
        double CrownRadiusOf(int treeId, double height)
        {
            double r;
            if (_crownR != null && _crownR.TryGetValue(treeId, out r) && r > 0.05) return r;
            return 0.5 * CrownWidthRatio * height;
        }

        static double SectorIntrusion(double lo, double hi, double sectorLo, double sectorHi)
        {
            double best = 0;
            for (int k = -1; k <= 1; k++)
            {
                double l = lo + 360.0 * k, h = hi + 360.0 * k;
                double ov = Math.Min(h, sectorHi) - Math.Max(l, sectorLo);
                if (ov > best) best = ov;
            }
            return best;
        }

        // 基于实际 4:3 取景的角度估算拍摄者先验重叠。径向投影的最宽处未必处于中线，
        // 尤其水平移轴时不能使用 sc +/- hf/2；沿画幅两侧采样反投影，与渲染共用 Proj。
        // 此结果仅表示与经验扇区重叠，不能证明其它位置没有人，也不识别人脸/头皮。
        void PhotoViewGeometry(double az, double aimEl, double baseEl, double topEl,
                               out double viewEl, out double hf, out double vf, out double shift)
        {
            bool level = _levelView;
            viewEl = level ? 0.0 : aimEl;
            double span = level ? 2.0 * Math.Max(-baseEl, topEl) + 8.0
                                : 2.0 * Math.Max(aimEl - baseEl, topEl - aimEl) + 8.0;
            vf = Geo.Clamp(span, 40.0, VF43Max);
            hf = Proj.Hfov(vf, 4.0 / 3.0);
            shift = 0.0;
            if (level)
            {
                double th = Proj.HalfScale(hf / 2.0), tv = Proj.HalfScale(vf / 2.0);
                double fx, fyTop, fyBase;
                Proj.PixelFromWorld(az, topEl, az, viewEl, th, tv, 0.0, out fx, out fyTop);
                if (fyTop < 0.06)
                {
                    Proj.PixelFromWorld(az, baseEl, az, viewEl, th, tv, 0.0, out fx, out fyBase);
                    shift = Math.Min(2.0 * (0.06 - fyTop), Math.Max(0.0, 2.0 * (0.98 - fyBase)));
                }
            }
        }

        static bool TreeFitsPhoto(double az, double baseEl, double topEl, double viewEl,
                                  double hf, double vf, double shift)
        {
            // PixelFromWorld 在不可投影时返回画面中心；先排除该退化情形，避免误判入框。
            if (Proj.NaturalD + Math.Cos(Geo.Rad(topEl - viewEl)) <= 1e-9 ||
                Proj.NaturalD + Math.Cos(Geo.Rad(baseEl - viewEl)) <= 1e-9) return false;
            double th = Proj.HalfScale(hf / 2.0), tv = Proj.HalfScale(vf / 2.0);
            double fx, topY, baseY;
            Proj.PixelFromWorld(az, topEl, az, viewEl, th, tv, shift, out fx, out topY);
            Proj.PixelFromWorld(az, baseEl, az, viewEl, th, tv, shift, out fx, out baseY);
            return IsFiniteSelectionValue(topY) && IsFiniteSelectionValue(baseY) &&
                   topY >= 0.0 && topY <= 1.0 && baseY >= 0.0 && baseY <= 1.0;
        }

        double PhotoOperatorOverlap(double az, double aimEl, double baseEl, double topEl, double a0)
        {
            double viewEl, hf, vf, shift;
            PhotoViewGeometry(az, aimEl, baseEl, topEl, out viewEl, out hf, out vf, out shift);
            return PhotoOperatorOverlapForView(az, viewEl, hf, vf, shift, a0);
        }

        static double PhotoOperatorOverlapForView(double az, double viewEl, double hf, double vf,
                                                  double shift, double a0)
        {
            double left = 0.0, right = 0.0;
            for (int j = 0; j <= 16; j++)
            {
                double v = -1.0 + 2.0 * j / 16.0;
                for (int side = -1; side <= 1; side += 2)
                {
                    double rayAz, rayEl;
                    Proj.WorldFromPixelNatural(side, v, az, viewEl, hf, vf, shift, out rayAz, out rayEl);
                    if (!IsFiniteSelectionValue(rayAz) || !IsFiniteSelectionValue(rayEl)) return 360.0;
                    double delta = Geo.Wrap180(rayAz - az);
                    left = Math.Min(left, delta);
                    right = Math.Max(right, delta);
                }
            }
            // 1° 容差覆盖有限采样中极值落在两个采样点之间的情形。
            double center = Geo.Wrap180(az - a0);
            return SectorIntrusion(center + left - 1.0, center + right + 1.0, PhotoPriorLo, PhotoPriorHi);
        }

        static bool IsFiniteSelectionValue(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        bool TryGetSelectionPose(int index, out double[] pose)
        {
            pose = null;
            if (_frames == null || _metaPose == null || index < 0 || index >= _frames.Frames.Count)
                return false;
            FrameInfo frame = _frames.Frames[index];
            return frame != null && !string.IsNullOrEmpty(frame.Name) &&
                   _metaPose.TryGetValue(frame.Name, out pose) && CameraPose.IsValid(pose);
        }

        string _frameSelectionFailure;

        void PickFrameUtm(UtmTree t, out double dist, out double bearing, out double elev, bool refine = false)
        {
            dist = 0; bearing = 0; elev = 0;
            _frameSelectionFailure = null;
            // 必须先清除上一次结果，失败时不能把旧帧当作新树的选帧结果。
            _manualFrameIdx = -1;
            if (t == null || !IsFiniteSelectionValue(t.X) || !IsFiniteSelectionValue(t.Y) ||
                _metaPose == null || _frames == null) return;
            if (_strictNearestFrame)
            {
                // -1 是找不到有效相机的显式标志；距离为 0 仍可能是有效最近帧。
                double treeX, treeY, horizontalDistance;
                TrunkAxisUtm(t, out treeX, out treeY);
                int closestIndex;
                if (!NearestFrame.TryFind(_frames.Frames, _metaPose, treeX, treeY,
                                          out closestIndex, out horizontalDistance)) return;
                FrameInfo closest = _frames.Frames[closestIndex];
                double[] closestPose = _metaPose[closest.Name];
                double a0 = PanoAzimuthFromOpk(closestPose[3], closestPose[4], closestPose[5])
                            + (double)_cal;
                double treeAz = Geo.Deg(Math.Atan2(treeX - closestPose[0], treeY - closestPose[1]));
                if (IsFiniteSelectionValue(t.Z) && IsFiniteSelectionValue(t.Height) && t.Height > 0.0)
                    UtmForest.TreeAzim(AimTrunk(t), closestPose[0], closestPose[1], closestPose[2],
                                       out bearing, out elev, out dist);
                else
                {
                    // 最近相机只依赖平面坐标：即便树高不可用，也保留严格最近帧。
                    // 后续不绘制缺少高程/树高依据的 4:3 定位与红圈。
                    bearing = Geo.Wrap360(treeAz);
                    elev = 0.0;
                    dist = horizontalDistance;
                }
                _pickAng = 180.0 - Math.Abs(Geo.Wrap180(treeAz - a0));
                _manualFrameIdx = closestIndex;
                return;
            }
            if (!IsFiniteSelectionValue(t.Z) || !IsFiniteSelectionValue(t.Height) || t.Height <= 0.0) return;
            int n = _frames.Frames.Count;
            const double DLO = 2.5, DHI = 30.0;       // 太近视差畸变大，太远树太小
            double cal = (double)_cal;         // 水平修正：渲染列0=panoRef+cal，sc 必须同口径
            // 选中树时的精细选帧结果按树缓存：拖准心/切图重算不会反复读全景图。
            // 启动自动选树（refine=false）仍只走几何最近帧，不为 228 棵树读图。
            RefinedChoice cached;
            double[] cachedPose;
            if (refine && _refinedChoices.TryGetValue(t.Id, out cached) && Math.Abs(cached.Cal - cal) < 1e-9 &&
                cached.LevelView == _levelView && cached.ProjectionD == Proj.NaturalD &&
                _frameReservations.IsAvailable(cached.Index, t.Id) &&
                TryGetSelectionPose(cached.Index, out cachedPose) &&
                IsFiniteSelectionValue(cached.Dist) && IsFiniteSelectionValue(cached.Az) &&
                IsFiniteSelectionValue(cached.El))
            {
                dist = cached.Dist; bearing = cached.Az; elev = cached.El;
                _pickAng = cached.Ang; _manualFrameIdx = cached.Index;
                return;
            }
            var aim = AimTrunk(t);                    // 瞄准点（树干中段），与十字/红圈同一套公式

            // 先收集实际投影参数，再在有限距离内优先选择未触及风险先验、树底树顶入框
            // 且镜头角度合适的帧。先验并非人像检测，无法提供“安全”保证。
            int pick = -1;
            bool blockedByReservation = false;
            var allCandidates = new List<FrameCandidate>();
            for (int i = 0; i < n; i++)
            {
                double[] mp;
                if (!TryGetSelectionPose(i, out mp)) continue;
                double dx = t.X - mp[0], dy = t.Y - mp[1];
                double dh = Geo.Dist2D(dx, dy);
                if (!IsFiniteSelectionValue(dh) || dh < DLO || dh > DHI) continue;
                if (refine && !_frameReservations.IsAvailable(i, t.Id))
                {
                    blockedByReservation = true;
                    continue;
                }
                double a0 = PanoAzimuthFromOpk(mp[3], mp[4], mp[5]) + cal;
                double azT = Geo.Deg(Math.Atan2(dx, dy));
                double sc = Geo.Wrap180(azT - a0);
                double off = 180.0 - Math.Abs(sc);              // 离前镜头中心的偏角
                double elA = Geo.Deg(Math.Atan((aim.Z - mp[2]) / dh));
                double elB = Geo.Deg(Math.Atan((t.Z - mp[2]) / dh));
                double elT = Geo.Deg(Math.Atan((t.Z + t.Height - mp[2]) / dh));
                if (!IsFiniteSelectionValue(elA) || !IsFiniteSelectionValue(elB) || !IsFiniteSelectionValue(elT)) continue;
                double viewEl, hf, vf, shift;
                PhotoViewGeometry(azT, elA, elB, elT, out viewEl, out hf, out vf, out shift);
                if (!IsFiniteSelectionValue(viewEl) || !IsFiniteSelectionValue(hf) ||
                    !IsFiniteSelectionValue(vf) || !IsFiniteSelectionValue(shift)) continue;
                double intr = PhotoOperatorOverlapForView(azT, viewEl, hf, vf, shift, a0);
                bool fits = TreeFitsPhoto(azT, elB, elT, viewEl, hf, vf, shift);
                allCandidates.Add(new FrameCandidate
                {
                    Index = i, Dh = dh, ElA = elA, ElB = elB, ElT = elT,
                    AzT = azT, A0 = a0, PriorOverlap = intr, Off = off, FitsPhoto = fits
                });
            }
            if (allCandidates.Count > 0)
            {
                allCandidates.Sort((a, b) => a.Dh.CompareTo(b.Dh));
                // 不能为避开经验扇区而无限远离目标。最近可用距离小于 5m 时允许最多
                // 10m；较远场景允许最多最近距离的两倍。不是保证目标无遮挡。
                double maxDistance = Math.Max(10.0, 2.0 * allCandidates[0].Dh);
                var preferred = new List<FrameCandidate>();
                FrameCandidate fallback = null;
                foreach (FrameCandidate candidate in allCandidates)
                {
                    if (candidate.Dh > maxDistance) break;
                    if (candidate.PriorOverlap <= 0.0 && candidate.Off <= QualityFrameMaxOffDeg && candidate.FitsPhoto)
                        preferred.Add(candidate);
                    // 无优选帧时先保留完整入框，再尽量减少先验重叠和镜头偏角；
                    // 所有候选均受距离上限约束，最终风险由照片状态如实告知。
                    if (fallback == null || (candidate.FitsPhoto && !fallback.FitsPhoto) ||
                        (candidate.FitsPhoto == fallback.FitsPhoto &&
                         (candidate.PriorOverlap < fallback.PriorOverlap - 1e-9 ||
                          (Math.Abs(candidate.PriorOverlap - fallback.PriorOverlap) < 1e-9 &&
                           candidate.Off < fallback.Off))))
                        fallback = candidate;
                }
                pick = preferred.Count > 0
                    ? (refine ? RefineFrameChoice(t, preferred).Index : preferred[0].Index)
                    : fallback.Index;
            }
            if (pick < 0)
            {
                // 有近处候选但已分配时，不能为了避免同帧悄悄退到超远或过近的照片。
                // 明确提示人工检查，比把不合适的画面伪装成独立观测更安全。
                if (refine && blockedByReservation)
                {
                    _frameSelectionFailure = "没有可用的独立自动主帧；已有近处帧分配给其他树，请手动选帧核查";
                    return;
                }
                // 距离窗口内一帧都没有（树离轨迹太远）：退回全局最近帧
                double bestD = double.MaxValue;
                for (int i = 0; i < n; i++)
                {
                    double[] mp;
                    if (!TryGetSelectionPose(i, out mp)) continue;
                    if (refine && !_frameReservations.IsAvailable(i, t.Id))
                    {
                        blockedByReservation = true;
                        continue;
                    }
                    double dx = t.X - mp[0], dy = t.Y - mp[1];
                    double dh = Geo.Dist2D(dx, dy);
                    if (IsFiniteSelectionValue(dh) && dh < bestD) { bestD = dh; pick = i; }
                }
            }
            if (pick < 0)
            {
                if (blockedByReservation)
                    _frameSelectionFailure = "没有可用的独立自动主帧；已有帧分配给其他树，请手动选帧核查";
                return;
            }
            double[] bmp;
            if (!TryGetSelectionPose(pick, out bmp)) return;
            double az, el, d;
            UtmForest.TreeAzim(aim, bmp[0], bmp[1], bmp[2], out az, out el, out d);
            // 对准角：树偏离前镜头中心的角度（0=正对），兜底帧也如实显示
            double pa0 = PanoAzimuthFromOpk(bmp[3], bmp[4], bmp[5]) + cal;
            double pAzT = Geo.Deg(Math.Atan2(t.X - bmp[0], t.Y - bmp[1]));
            _pickAng = 180.0 - Math.Abs(Geo.Wrap180(pAzT - pa0));
            _manualFrameIdx = pick;
            bearing = az; elev = el; dist = d;
            if (refine)
                _refinedChoices[t.Id] = new RefinedChoice
                {
                    Index = pick, Dist = d, Az = az, El = el, Ang = _pickAng, Cal = cal,
                    LevelView = _levelView, ProjectionD = Proj.NaturalD
                };
        }
        double _pickAng = 180.0;   // 选中帧里树偏离前镜头中心的角度(°，0=正对)

        // UTM 模式下算出「整棵树」的标注几何，供底部 4:3 照片把整棵树框出来：
        //   树底/树顶/树号锚点(树顶往下20%树高)的世界仰角 → _markEl*
        //   树冠左右缘(冠幅最宽处 0.70H)的世界方位/仰角 → _markAz* / _markEl*
        // 并顺带按树高自动适配切图视场角（树或帧变了才写一次，避免抖动）。
        // 仅在 UTM 模式选中树、且当前帧有 Metashape 姿态时算出几何；无姿态的帧画不出
        // 标注，但树号保留（树还选着，识别面板不能显示成「第 0 号树」）。
        void UpdateTreeMark(int selUtm, FrameInfo fi, double bearing, double elev)
        {
            _markHasSpan = false;
            _markTreeNo = 0;
            _markElTrunk = 0;
            _markAzTrunk = 0;
            _markDAz = 0; _markDEl = 0;
            _markMode = "未选中树";
            if (_utmForest == null || selUtm < 0 || selUtm >= _utmForest.Trees.Count) return;
            // UI 的数字控件是列表序号，树号必须来自数据本身；新场地 ID 可能不连续。
            _markTreeNo = _utmForest.Trees[selUtm].Id;
            double[] mp;
            if (_metaPose == null || !_metaPose.TryGetValue(fi.Name, out mp))
            {
                // 切帧切到无姿态的帧（全景包 1292 帧里有 376 帧不在 Metashape 里）：
                // 只是本帧画不出标注，选中的树不变
                _markMode = "当前帧无姿态，画不出标注";
                return;
            }

            var t = _utmForest.Trees[selUtm];
            double camX = mp[0], camY = mp[1], camZ = mp[2];

            // 树底/树顶/树号锚点的仰角：按世界坐标取点精确算，不做角度插值——
            // 近树时 atan 强非线性，插值会把树号压到树干中下部
            double az, elB, d0, elT, elC;
            UtmForest.TreeAzim(t.X, t.Y, t.Z, camX, camY, camZ, out az, out elB, out d0);
            UtmForest.TreeAzim(t.X, t.Y, t.Z + t.Height, camX, camY, camZ, out az, out elT, out d0);
            UtmForest.TreeAzim(t.X, t.Y, t.Z + 0.8 * t.Height, camX, camY, camZ, out az, out elC, out d0);
            // 自动标注几何（未加手动偏移）：手动拖动是「整树标注整体平移」，
            // 偏移量叠在下面这组自动值上（见 ApplyMarkOffset）。
            _autoElBase = elB; _autoElTop = elT; _autoElCrown = elC;
            // 红圈锚点：树干段（TrunkMarkH）在「树干轴心」处的精确方位/仰角。
            // 横向必须用点云实测的树干轴心（TrunkAxisUtm），不能用树心坐标——树心是
            // 树冠重心，105号实测干心比冠心偏 0.15m，3m 近距下红圈会压在树干左缘。
            // 与树号锚点一样按世界坐标取点算，不做角度插值（近树时 atan 非线性）。
            double tux, tuy;
            bool hasTrunk = TrunkAxisUtm(t, out tux, out tuy);
            double azTrunk, elTrunk;
            UtmForest.TreeAzim(tux, tuy, t.Z + TrunkMarkH(t.Height), camX, camY, camZ,
                               out azTrunk, out elTrunk, out d0);
            // 历史人工 CSV 的零点含固定偏置，必须保留；新自动结果不再把一棵树的
            // 经验偏置强加给所有缺轴心的树，缺数据时明确退回树心方位。
            _manualBaseAzTrunk = hasTrunk ? azTrunk : Geo.Wrap360(bearing + TrunkAzBias);
            _manualBaseElTrunk = elTrunk;
            _autoAzTrunk = hasTrunk || HasManualMark(t.Id) ? _manualBaseAzTrunk : Geo.Wrap360(bearing);
            _autoElTrunk = elTrunk;
            // 双帧交会：仅 Success / Fallback 两态用交会结果覆盖红圈自动锚点。
            // Disabled / ManualSkipped 两态一律保留上面这组旧 TrunkMarkH + TrunkAxisUtm 口径，
            // 保证 9.13 基线（含 7 棵历史人工校正树）红圈像素位置逐项一致。
            DualFrameResult dfr = _dualFrameCur;
            if (dfr != null && (dfr.Status == DualFrameStatus.Success || dfr.Status == DualFrameStatus.Fallback))
            {
                _autoAzTrunk = Geo.Wrap360(dfr.AzNew);
                _autoElTrunk = dfr.ElNew;
            }

            // 树冠左右缘：在冠幅最宽处沿「垂直视线」方向取左右边缘点。
            // 视线水平方向为 (sin b, cos b)，其垂线即 (cos b, -sin b)。
            double br = Geo.Rad(bearing);
            double pc = Math.Cos(br), ps = -Math.Sin(br);
            double r = CrownRadiusOf(t.Id, t.Height);
            double zc = t.Z + CrownWidthZ * t.Height;
            double azL, elL, dL, azR, elR, dR;
            UtmForest.TreeAzim(t.X - r * pc, t.Y - r * ps, zc, camX, camY, camZ, out azL, out elL, out dL);
            UtmForest.TreeAzim(t.X + r * pc, t.Y + r * ps, zc, camX, camY, camZ, out azR, out elR, out dR);
            _autoAzL = azL; _autoElL = elL; _autoAzR = azR; _autoElR = elR;

            // 叠加该树的手动偏移（若有）：整树标注整体平移（绿框/红竖线/黄刻度/红圈/树号一起走）
            bool manual = ApplyMarkOffset(t.Id);
            _markHasSpan = true;
            _markMode = MarkModeText(manual);

            // 按树高自动适配切图视场角：装下整棵树（树底~树顶相对瞄准点的仰角差）+6° 边距
            if (selUtm != _fitTree || fi.Gps != _fitGps)
            {
                _fitTree = selUtm; _fitGps = fi.Gps;
                double span = Geo.Clamp(2.0 * Math.Max(elev - elB, elT - elev) + 6.0, 1.0, VF43Max);
                // 切图为 3:4，按视场范围约束水平角。
                double hf = Geo.Clamp(Proj.Hfov(span, 3.0 / 4.0), 1.0, 120.0);
                _cropHeight = (decimal)Math.Round(span);
                _cropWidth = (decimal)Math.Round(hf);
            }
        }

        // 把某棵树的手动偏移（相对自动树干锚点的 dAz/dEl）叠加到全部标注几何上，
        // 实现「整树标注（绿框+红竖线+黄刻度+红圈+树号）整体平移」。返回是否处于手动状态。
        bool ApplyMarkOffset(int treeId)
        {
            double dAz = 0, dEl = 0;
            double[] off = null;
            bool manual = _markManual != null && _markManual.TryGetValue(treeId, out off);
            if (manual) { dAz = off[0]; dEl = off[1]; }
            _markDAz = dAz; _markDEl = dEl;   // 记下本次生效的偏移（切图渲染中心要用）
            _markElBase  = _autoElBase  + dEl;
            _markElTop   = _autoElTop   + dEl;
            _markElCrown = _autoElCrown + dEl;
            _markElTrunk = _autoElTrunk + dEl;
            _markAzTrunk = Geo.Wrap360(_autoAzTrunk + dAz);
            _markAzL     = Geo.Wrap360(_autoAzL + dAz);
            _markAzR     = Geo.Wrap360(_autoAzR + dAz);
            _markElL     = _autoElL + dEl;
            _markElR     = _autoElR + dEl;
            return manual;
        }

        // 自动选帧失败时不能保留上一棵树的画面，否则用户会误以为旧帧属于当前树。
        // 只清理派生图像和定位状态，不修改已加载的数据、所选树或人工校正。
        void ClearFrameProducts(string message)
        {
            _markHasSpan = false;
            _markTreeNo = 0;
            _dualFrameCur = null;
            _markMode = "无定位结果";
            ClearPersonHeadDetection();
            ReplaceImage(ref _photo, null);
            ReplaceImage(ref _crop, null);
            ReplaceImage(ref _recogClean, null);
            ReplaceImage(ref _cropClean, null);
            ClearHeat(message);
            _recognition = "";
            _photoRiskState = "unavailable";
            _photoRiskReason = message;
            _status = message;
        }

        void ClearUnavailableFrame(string message)
        {
            _pano.SetSource(null);
            _curFrame = null;
            _curName = null;
            _manualFrameIdx = -1;
            ClearFrameProducts(message);
        }

        void Recompute()
        {
            if (_frames == null || _poses == null || _frames.Frames.Count == 0) return;

            double bearing = (double)_bearing;
            double dist = (double)_distance;
            double elev = (double)_elevation;
            double Cal = (double)_cal, CalV = (double)_calV;
            bool auto = _autoFrame;
            // 双帧以自动主帧或用户固定帧为 A；启动全量加载期间不触发。
            UtmTree dualFrameTree = null;
            double dualFrameAz = 0.0, dualFrameEl = 0.0;
            bool dualFrameReady = false;

            FrameInfo fi; Pose pose;
            int selUtm = _selUtmTree;
            if (auto)
            {
                // UTM 树心模式：用树的 UTM 坐标 + Metashape 选帧
                if (_utmForest != null && selUtm >= 0 && selUtm < _utmForest.Trees.Count)
                {
                    var t = _utmForest.Trees[selUtm];
                    if (t == null || !IsFiniteSelectionValue(t.X) || !IsFiniteSelectionValue(t.Y))
                    {
                        ClearUnavailableFrame("当前树的平面坐标无效，无法定位；请检查树心数据");
                        return;
                    }
                    if (!_strictNearestFrame && (!IsFiniteSelectionValue(t.Z) ||
                        !IsFiniteSelectionValue(t.Height) || t.Height <= 0.0))
                    {
                        ClearUnavailableFrame("当前树的树高或高程无效，无法自动取景；请检查树心数据");
                        return;
                    }
                    double d, az, el;
                    PickFrameUtm(t, out d, out az, out el, true);
                    // 是否成功由有效帧下标和有限几何值判定；距离为 0 也是合法值。
                    if (_manualFrameIdx >= 0 && _manualFrameIdx < _frames.Frames.Count &&
                        d >= 0.0 && IsFiniteSelectionValue(d) && IsFiniteSelectionValue(az) &&
                        IsFiniteSelectionValue(el))
                    {
                        fi = _frames.Frames[_manualFrameIdx];
                        pose = _poses.GetAt(fi.Gps);
                        bearing = az; dist = d; elev = el;
                        // 同步到手轮：全景上的十字与「最近照片」的红圈都读这三个值，
                        // 不写回的话两者会用不同的方位，出现"两个红点不是同一棵树"
                        SetTargetInputs(az, d, el);
                        dualFrameTree = t;
                        dualFrameAz = az;
                        dualFrameEl = el;
                        // DEF-06：启动全量加载期间禁止双帧旁路（0 计算 / 0 读图 / 0 日志）。
                        dualFrameReady = !_startupGuard;
                    }
                    else
                    {
                        ClearUnavailableFrame(_frameSelectionFailure ?? "当前树没有可用的相机位姿，无法定位；请检查数据或选择其他树");
                        return;
                    }
                }
                else
                {
                    // 没有树心坐标时按方位角兜底选帧
                    PickFrame(bearing, out fi, out pose);
                }
            }
            else
            {
                if (_manualFrameIdx < 0 || _manualFrameIdx >= _frames.Frames.Count)
                    _manualFrameIdx = 0;
                fi = _frames.Frames[_manualFrameIdx];
                pose = _poses.GetAt(fi.Gps);
                // 固定当前帧时仍可把它作为 A，由算法自动选择另一帧 B。
                // 两帧始终基于该树与当前相机的真实几何，而非旧帧的手动方向。
                double[] framePose;
                if (!_startupGuard && _dualFrameEnabled &&
                    _utmForest != null && selUtm >= 0 && selUtm < _utmForest.Trees.Count &&
                    _metaPose != null && _metaPose.TryGetValue(fi.Name, out framePose) &&
                    framePose != null && framePose.Length >= 3)
                {
                    dualFrameTree = _utmForest.Trees[selUtm];
                    double unusedDistance;
                    UtmForest.TreeAzim(AimTrunk(dualFrameTree), framePose[0], framePose[1], framePose[2],
                                       out dualFrameAz, out dualFrameEl, out unusedDistance);
                    dualFrameReady = true;
                }
            }
            double[] selectedPose = null;
            bool hasCompletePose = _metaPose != null &&
                                   _metaPose.TryGetValue(fi.Name, out selectedPose) &&
                                   CameraPose.IsValid(selectedPose);
            _curPanoRef = hasCompletePose ? PanoAzimuthFromOpk(selectedPose[3], selectedPose[4], selectedPose[5])
                          : pose != null && IsFiniteSelectionValue(pose.Heading) ? pose.Heading : 0.0;

            // 加载帧（有缓存：帧名不变就不重新加载）；旧帧交给 PanoramaRenderer 安全释放
            if (fi.Name != _curName)
            {
                Bitmap nextFrame = _frames.Load(fi.Name);
                if (nextFrame == null)
                {
                    ClearUnavailableFrame("所选全景帧无法读取，请检查照片压缩包后重试");
                    return;
                }
                _pano.SetSource(nextFrame);
                _curFrame = nextFrame;
                _curName = fi.Name;
            }

            // 用户手动选择了无完整位姿的帧时仍可浏览原始全景；但无法计算当前树
            // 的 4:3 取景和红圈，不能把上一帧的方向当作新帧的定位结果。
            if (!auto && _utmForest != null && selUtm >= 0 && selUtm < _utmForest.Trees.Count && !hasCompletePose)
            {
                ClearFrameProducts("当前帧缺少完整相机位姿，只能浏览全景；请切换帧或恢复自动选帧");
                PushPanoTarget();
                return;
            }

            if (hasCompletePose && _utmForest != null && selUtm >= 0 && selUtm < _utmForest.Trees.Count)
            {
                UtmTree selectedTree = _utmForest.Trees[selUtm];
                if (!IsFiniteSelectionValue(selectedTree.Z) || !IsFiniteSelectionValue(selectedTree.Height) ||
                    selectedTree.Height <= 0.0)
                {
                    ClearFrameProducts("树高或高程无效，保留当前帧但无法计算树木取景和标注");
                    PushPanoTarget();
                    return;
                }
                double trunkX, trunkY;
                TrunkAxisUtm(selectedTree, out trunkX, out trunkY);
                if (Geo.Dist2D(trunkX - selectedPose[0], trunkY - selectedPose[1]) < 1e-6)
                {
                    // 相机与树干重合时最近帧仍然合法，但方位角在物理上没有定义。
                    ClearFrameProducts("相机与树干位置重合，无法确定树干方向；保留当前帧，请切换其他帧核查");
                    PushPanoTarget();
                    return;
                }
            }

            // 双帧定位只使用当前 A；无可靠证据时由引擎返回明确的估计/回退状态。
            if (dualFrameReady)
                PrepareDualFrame(dualFrameTree, fi, dualFrameAz, dualFrameEl, bearing, elev);
            else
                _dualFrameCur = null;
            UpdateTreeMark(selUtm, fi, bearing, elev);
            // 在自动适配之后才读切图垂直高，保证本次渲染就用新视场角
            double tiltD = (double)_cropHeight;
            UpdateNearestPhoto(bearing, elev, tiltD, Cal, CalV);

            // 切图：径向球面透视重投影 —— 把 360 全景转成普通视角，减轻局部拉伸。
            // 画面中心=选中树，「切图水平宽/垂直高」即视场角。
            // （最早直接在等距柱状图上抠矩形像素，高处水平拉伸、树干弯曲，那才是映射畸变）
            RefreshCrop();

            // 只有帧已读取并生成有效照片时才占用，失败不会锁住其他树的候选。
            if (_markHasSpan && _photo != null && _utmForest != null &&
                selUtm >= 0 && selUtm < _utmForest.Trees.Count)
            {
                int treeId = _utmForest.Trees[selUtm].Id;
                if (!auto || _strictNearestFrame)
                    _frameReservations.ReserveShared(_manualFrameIdx, treeId);
                else
                    _frameReservations.Reserve(_manualFrameIdx, treeId);
            }

            // 全景预览（后台线程渲染）
            if (_curFrame != null)
            {
                SyncLockViewToMark(bearing, elev);
                PushPanoTarget();
            }
            string fsize = "加载中...";
            if (_curFrame != null)
            {
                int fw = 0, fh = 0;
                lock (_pano.SyncRoot) { if (_curFrame != null) { fw = _curFrame.Width; fh = _curFrame.Height; } }
                fsize = fw + "x" + fh;
            }
            _status = "方位 " + bearing.ToString("f1") + "° / 距离 " + dist.ToString("f1") + "m → 帧 " + fi.Name + "  分辨率 " + fsize;
            if (_markHasSpan && hasCompletePose)
            {
                double photoEl, photoHf, photoVf, photoShift;
                PhotoViewGeometry(bearing, elev, _autoElBase, _autoElTop,
                                  out photoEl, out photoHf, out photoVf, out photoShift);
                if (!TreeFitsPhoto(bearing, _autoElBase, _autoElTop, photoEl, photoHf, photoVf, photoShift))
                    _status += "  注意：树顶或树底超出画面";
                double overlap = PhotoOperatorOverlap(bearing, elev, _autoElBase, _autoElTop, _curPanoRef + Cal);
                SetPhotoRiskFromDetection(overlap > 0.0);
                if (overlap > 0.0 || _photoRiskState == "detected")
                    _status += "  注意：可能拍入人体或头部，请核查";
            }
            else
            {
                _photoRiskState = "unavailable";
                _photoRiskReason = "当前画面没有可用的树木定位结果";
            }
            AppendDualFrameStatus();
        }

        // 重渲染右侧切图：画面中心=校正后的树位（取景瞄准点 + 该树的手动偏移）。
        // 拖动准心是「树在哪」的校正，切图必须跟着重新对准树——否则画面像素不变、
        // 只有树号挪位置。视场角仍用自动适配的「切图水平宽/垂直高」，不重算、不缩放跳变；
        // 偏移整体平移后树正好落回视场规划的位置（整棵入框、树号在树冠上）。
        // Recompute 每次全量重算时也走这里。
        void RefreshCrop()
        {
            if (_curFrame == null) return;
            double bearing = (double)_bearing;
            double elev = (double)_elevation;
            // 与 RenderRectilinear 内部的视场钳制同口径：否则手轮拉到 170° 以上时
            // 树号按未钳制的视场算位置，会印到实际渲染出来的树冠之外
            double panD = Geo.Clamp((double)_cropWidth, 1, FovMax);
            double tiltD = Geo.Clamp((double)_cropHeight, 1, FovMax);
            double cal = (double)_cal, calV = (double)_calV;
            double cAz = Geo.Wrap360(bearing + _markDAz);
            double cEl = elev + _markDEl;
            lock (_pano.SyncRoot)
            {
                if (_curFrame == null) return;
                var crop = RenderRectilinear(_curFrame, cAz, cEl, panD, tiltD, _curPanoRef, cal, calV);
                if (crop == null) return;
                // 识别输入用未烤树号的干净切图：树号大白字会干扰模型看树
                var clean = (Bitmap)crop.Clone();
                if (_cropClean != null) _cropClean.Dispose();
                _cropClean = clean;
                // 树号印在树冠上（烤进位图：保存的切图自带树号）
                if (_markHasSpan && _markTreeNo > 0)
                    DrawTreeNoOnCrown(crop, cAz, cEl, panD, tiltD);
                ReplaceImage(ref _crop, crop);
            }
            // 切图的视场与 4:3 照片不同，必须单独检测，不能借用照片结果。
            UpdateCropPersonHeadDetection(_cropClean, cAz, cEl, panD, tiltD, cal, calV);
        }
    }
}
