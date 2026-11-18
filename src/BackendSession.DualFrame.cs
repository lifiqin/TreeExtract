using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;

namespace TreeExtractor
{
    /// <summary>
    /// 双帧交会定位在后端会话中的编排：字段 / 执行入口 / 状态 / 缓存失效 / 数据集标识 /
    /// 架次段 ID。只在 Recompute 的 refine=true 选中树路径触发；启动全量 refine=false 不触发。
    /// </summary>
    public partial class BackendSession
    {
        /// <summary>按树、数据集、主帧、校准参数和主视图投影参数缓存双帧结果。</summary>
        readonly Dictionary<DualFrameCacheKey, DualFrameResult> _dualFrameCache
            = new Dictionary<DualFrameCacheKey, DualFrameResult>();

        /// <summary>当前树结果，供 UpdateTreeMark / AppendDualFrameStatus 共享，不得各自重算。</summary>
        DualFrameResult _dualFrameCur;

        /// <summary>当前树心数据集标识（LoadUtmData 时重算）。</summary>
        string _dataSetId;

        /// <summary>
        /// DEF-06：启动全量加载（AutoLoadAll / AutoSelectStartupTree）期间为 true。
        /// Recompute 的 refine=true 选中树路径必须同时满足 !_startupGuard 才挂双帧旁路，
        /// 保证启动阶段 0 次双帧计算、0 张新增读图、0 条「双帧 」日志（E1/C3）。
        /// </summary>
        bool _startupGuard = false;

        /// <summary>DEF-04：帧名 → 架次段 ID（按 GPS 排序，间隔 &gt; FlightGapSec 切段）。</summary>
        readonly Dictionary<string, int> _flightSegment
            = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        /// <summary>架次段数量（供日志核对）。</summary>
        int _flightSegmentCount = 0;

        /// <summary>
        /// 数据集标识：树心文件绝对路径 + 文件大小 + 最后写入时间。
        /// 同一路径换了数据也能区分，避免跨数据集缓存串味。
        /// </summary>
        internal static string DataSetIdOf(string treeCentersPath)
        {
            try
            {
                string raw = string.IsNullOrEmpty(treeCentersPath) ? AppPaths.TreePath : treeCentersPath;
                string p = Path.GetFullPath(raw);
                var fi = new FileInfo(p);
                string stamp = fi.Exists
                    ? fi.Length.ToString(CultureInfo.InvariantCulture) + "|"
                      + fi.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture)
                    : "missing";
                return p.ToUpperInvariant() + "|" + stamp;
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 数据集标识解析失败: " + ex.Message);
                return (treeCentersPath == null ? "unknown" : treeCentersPath) + "|unknown";
            }
        }

        /// <summary>
        /// 帧名 GPS 时间 → 秒。FrameInfo.Gps 由帧名（如 12345.678.jpg）解析而来，
        /// 本身已是时间标量；异常时退回按帧名再解析一次。
        /// DEF-04 起只用于构建架次段，不再用于 A/B 配对判据。
        /// </summary>
        internal static double GpsSeconds(FrameInfo fi)
        {
            if (fi == null) return double.NaN;
            double v = fi.Gps;
            if (!double.IsNaN(v) && !double.IsInfinity(v)) return v;
            string name = fi.Name == null ? "" : fi.Name;
            int dot = name.LastIndexOf('.');
            string s = dot > 0 ? name.Substring(0, dot) : name;
            double parsed;
            if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed))
                return parsed;
            return double.NaN;
        }

        /// <summary>
        /// DEF-04：按 _frames.Frames 的 GPS 排序，相邻帧间隔 &gt; FlightGapSec(180s) 即 segmentId++，
        /// 建立 frameName→segmentId。D3 两架次交界 339.66s 会被正确切成两段。
        /// 不使用「A/B GPS 差 ≤600s」——该判据对 339.66s 交界完全失效。
        /// </summary>
        void BuildFlightSegments()
        {
            _flightSegment.Clear();
            _flightSegmentCount = 0;
            try
            {
                if (_frames == null || _frames.Frames == null || _frames.Frames.Count == 0) return;
                var ordered = new List<FrameInfo>(_frames.Frames);
                ordered.Sort(delegate(FrameInfo a, FrameInfo b)
                {
                    return GpsSeconds(a).CompareTo(GpsSeconds(b));
                });
                int seg = 0;
                double prev = double.NaN;
                foreach (FrameInfo f in ordered)
                {
                    double t = GpsSeconds(f);
                    if (!double.IsNaN(prev) && !double.IsNaN(t)
                        && (t - prev) > DualFrameConfig.FlightGapSec) seg++;
                    if (!string.IsNullOrEmpty(f.Name)) _flightSegment[f.Name] = seg;
                    if (!double.IsNaN(t)) prev = t;
                }
                _flightSegmentCount = seg + 1;
                // 不带「双帧 」前缀：避免污染 E1「启动段 0 条双帧日志」与 QA 日志条数统计。
                BackendLog.Write("架次分段 帧数=" + ordered.Count.ToString(CultureInfo.InvariantCulture)
                    + " 段数=" + _flightSegmentCount.ToString(CultureInfo.InvariantCulture)
                    + " 间隔阈值=" + DualFrameConfig.FlightGapSec.ToString("F0", CultureInfo.InvariantCulture) + "s");
            }
            catch (Exception ex)
            {
                BackendLog.Write("架次分段 失败: " + ex.Message);
            }
        }

        int FlightSegmentOf(string frameName)
        {
            int seg;
            if (!string.IsNullOrEmpty(frameName) && _flightSegment.TryGetValue(frameName, out seg))
                return seg;
            return -1;
        }

        /// <summary>
        /// 清空全部双帧缓存（LoadUtmData 重载 / 开关切换时调用）。
        /// DEF-01：同步清空回放行；DEF-04：同步重建架次段。
        /// </summary>
        void ClearDualFrameCache()
        {
            _dualFrameCache.Clear();
            _dualFrameCur = null;
            DualFrameEngine.ResetReplay();
            BuildFlightSegments();
        }

        /// <summary>
        /// 使某棵树（treeId&lt;0 或 all=true 则全部）的双帧结果失效。
        /// 人工「保存校正 / 重置为自动」后调用，保证人工优先状态即时生效。
        /// DEF-01：同步使回放 CSV 对应行失效。
        /// </summary>
        void InvalidateDualFrame(int treeId, bool all)
        {
            try
            {
                if (all || treeId < 0)
                {
                    _dualFrameCache.Clear();
                    _dualFrameCur = null;
                    DualFrameEngine.ResetReplay();
                    return;
                }
                var dead = new List<DualFrameCacheKey>();
                foreach (DualFrameCacheKey k in _dualFrameCache.Keys)
                    if (k.TreeId == treeId) dead.Add(k);
                foreach (DualFrameCacheKey k in dead) _dualFrameCache.Remove(k);
                _dualFrameCur = null;
                DualFrameEngine.InvalidateReplayTree(treeId);
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 缓存失效失败: " + ex.Message);
            }
        }

        /// <summary>
        /// 状态栏四态文案。状态文案使用紧凑写法：
        /// 当前：自动（双帧交会） / 当前：自动（树干锚点·单帧回退） /
        /// 当前：手动（已校正） / 当前：人工优先（已跳过双帧）。
        /// </summary>
        string MarkModeText(bool manual)
        {
            if (_dualFrameCur != null && _dualFrameCur.Status == DualFrameStatus.ManualSkipped)
                return "当前：人工优先·跳过";
            if (manual) return "当前：手动·已校正";
            if (_dualFrameCur == null) return "当前：自动·树干锚点";
            if (_dualFrameCur.Status == DualFrameStatus.Success) return "当前：自动·双帧交会";
            if (_dualFrameCur.Status == DualFrameStatus.Disabled) return "当前：自动·树干锚点";
            return "当前：自动·单帧回退";
        }

        /// <summary>
        /// 在 _status 被覆写之后追加双帧状态串；必须在覆写之后调用，否则会被冲掉。
        /// 无当前结果（启动全量选帧 / 非 UTM 路径）时不做任何追加、不写日志。
        /// </summary>
        void AppendDualFrameStatus()
        {
            if (_dualFrameCur == null) return;
            try
            {
                _status = _status + "  " + _dualFrameCur.StatusText;
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 状态栏追加失败: " + ex.Message);
            }
        }

        /// <summary>
        /// 重建辅助帧候选：观测和交会使用树干轴心；实际 4:3 取景、经验风险和
        /// 树顶/树底入框判断使用树心，与主帧渲染保持同一口径。风险先验不是人像检测。
        /// </summary>
        internal FrameCandidate MakeDualFrameCandidate(UtmTree t, double[] mp, int index, double cal,
                                              out bool hardOk, bool isPrimary = false)
        {
            hardOk = false;
            if (t == null || !CameraPose.IsValid(mp)) return null;
            double trunkX, trunkY;
            TrunkAxisUtm(t, out trunkX, out trunkY);
            double dx = trunkX - mp[0];
            double dy = trunkY - mp[1];
            double dh = Geo.Dist2D(dx, dy);
            bool inRange = dh >= DualFrameConfig.CandidateMinDhM && dh <= DualFrameConfig.CandidateMaxDhM;
            // 主帧允许是用户固定或严格最近的帧；极端重合时方位无定义，明确回退。
            if (dh < 0.05 || (!inRange && !isPrimary)) return null;

            double a0 = PanoAzimuthFromOpk(mp[3], mp[4], mp[5]) + cal;
            double azT = Geo.Deg(Math.Atan2(dx, dy));
            UtmTree aim = AimTrunk(t);
            double elA = Geo.Deg(Math.Atan((aim.Z - mp[2]) / dh));
            double elB = Geo.Deg(Math.Atan((t.Z - mp[2]) / dh));
            double elT = Geo.Deg(Math.Atan((t.Z + t.Height - mp[2]) / dh));

            // 树心与实测树干轴心可能不重合：前者控制画面构图，后者用于几何观测。
            double centerDx = t.X - mp[0], centerDy = t.Y - mp[1];
            double centerDh = Geo.Dist2D(centerDx, centerDy);
            if (!IsFiniteSelectionValue(centerDh) || centerDh < 1e-6) return null;
            double centerAz = Geo.Deg(Math.Atan2(centerDx, centerDy));
            double centerAimEl = Geo.Deg(Math.Atan2(aim.Z - mp[2], centerDh));
            double centerBaseEl = Geo.Deg(Math.Atan2(t.Z - mp[2], centerDh));
            double centerTopEl = Geo.Deg(Math.Atan2(t.Z + t.Height - mp[2], centerDh));
            double viewEl, hf, vf, shift;
            PhotoViewGeometry(centerAz, centerAimEl, centerBaseEl, centerTopEl,
                              out viewEl, out hf, out vf, out shift);
            double intr = PhotoOperatorOverlapForView(centerAz, viewEl, hf, vf, shift, a0);
            double off = 180.0 - Math.Abs(Geo.Wrap180(centerAz - a0));
            bool fits = TreeFitsPhoto(centerAz, centerBaseEl, centerTopEl, viewEl, hf, vf, shift);

            var c = new FrameCandidate
            {
                Index = index,
                Dh = dh,
                ElA = elA,
                ElB = elB,
                ElT = elT,
                AzT = azT,
                A0 = a0,
                PriorOverlap = intr,
                Off = off,
                FitsPhoto = fits,
                Occ = 0,
                Q = 0.0
            };
            hardOk = inRange && intr <= 0.0 && off <= QualityFrameMaxOffDeg && fits;
            return c;
        }

        List<FrameCandidate> BuildDualFrameCandidates(UtmTree t, double cal,
                                                      int indexA, out FrameCandidate candA)
        {
            candA = null;
            var list = new List<FrameCandidate>();
            if (_frames == null || _metaPose == null || t == null) return list;
            for (int i = 0; i < _frames.Frames.Count; i++)
            {
                double[] mp;
                if (!TryGetSelectionPose(i, out mp)) continue;
                bool ok;
                FrameCandidate c = MakeDualFrameCandidate(t, mp, i, cal, out ok, i == indexA);
                if (c == null) continue;
                if (i == indexA) candA = c;
                if (ok) list.Add(c);
            }
            return list;
        }

        // 与 UpdateNearestPhoto 共用 4:3 视场和移轴口径，供双帧结果计算画面内的可见中点。
        // 返回的 fx/fy 为未裁剪的归一化坐标；超出 [0,1] 可用于求画幅交点。
        internal Func<double, double, double[]> CreatePrimaryPhotoProjector(UtmTree tree, double[] pose,
                                                                  double bearing, double elevation)
        {
            if (tree == null || !CameraPose.IsValid(pose) ||
                !IsFiniteSelectionValue(bearing) || !IsFiniteSelectionValue(elevation)) return null;
            double unusedAz, baseEl, topEl, unusedDistance;
            UtmForest.TreeAzim(tree.X, tree.Y, tree.Z, pose[0], pose[1], pose[2],
                               out unusedAz, out baseEl, out unusedDistance);
            UtmForest.TreeAzim(tree.X, tree.Y, tree.Z + tree.Height, pose[0], pose[1], pose[2],
                               out unusedAz, out topEl, out unusedDistance);
            double viewEl, hf, vf, shift;
            PhotoViewGeometry(bearing, elevation, baseEl, topEl, out viewEl, out hf, out vf, out shift);
            double th = Proj.HalfScale(hf / 2.0), tv = Proj.HalfScale(vf / 2.0);
            if (!IsFiniteSelectionValue(th) || !IsFiniteSelectionValue(tv) || th <= 0.0 || tv <= 0.0)
                return null;
            return delegate(double az, double el)
            {
                if (!IsFiniteSelectionValue(az) || !IsFiniteSelectionValue(el)) return null;
                // PixelFromWorld 在奇异方向返回画幅中心；这里必须拒绝，不能伪造有效观测。
                double a = Geo.Rad(az - bearing), e = Geo.Rad(el), e0 = Geo.Rad(viewEl);
                double forward = Math.Cos(e) * Math.Cos(a) * Math.Cos(e0) + Math.Sin(e) * Math.Sin(e0);
                if (Proj.NaturalD + forward <= 1e-9) return null;
                double fx, fy;
                Proj.PixelFromWorld(az, el, bearing, viewEl, th, tv, shift, out fx, out fy);
                return IsFiniteSelectionValue(fx) && IsFiniteSelectionValue(fy)
                    ? new double[] { fx, fy } : null;
            };
        }

        // 对交会点做保守的目标归属检查。树干缺测时退回树心；这不是图像级目标识别。
        internal bool AxisConflictsNeighbor(UtmTree target, double x, double y)
        {
            if (target == null || _utmForest == null || !IsFiniteSelectionValue(x) ||
                !IsFiniteSelectionValue(y)) return true;
            double targetX, targetY;
            TrunkAxisUtm(target, out targetX, out targetY);
            double targetDistance = Geo.Dist2D(x - targetX, y - targetY);
            if (!IsFiniteSelectionValue(targetDistance)) return true;
            foreach (UtmTree other in _utmForest.Trees)
            {
                if (other == null || other.Id == target.Id) continue;
                double otherX, otherY;
                TrunkAxisUtm(other, out otherX, out otherY);
                double otherDistance = Geo.Dist2D(x - otherX, y - otherY);
                if (IsFiniteSelectionValue(otherDistance) &&
                    otherDistance <= targetDistance + DualFrameConfig.NeighborAxisMinMarginM)
                    return true;
            }
            return false;
        }

        // 拒绝树干观测自身落在拍摄者经验扇区；这是保守先验，不是人体检测。
        internal static bool ObservationAtOperatorRisk(FrameCandidate frame, TrunkMeasure observation)
        {
            if (frame == null || !IsFiniteSelectionValue(frame.A0) ||
                !IsFiniteSelectionValue(observation.AzPix) ||
                !IsFiniteSelectionValue(observation.WidthDeg) || observation.WidthDeg < 0.0)
                return true;
            double center = Geo.Wrap180(observation.AzPix - frame.A0);
            double radius = 0.5 * observation.WidthDeg + 1.0;
            return SectorIntrusion(center - radius, center + radius, PhotoPriorLo, PhotoPriorHi) > 0.0;
        }

        /// <summary>
        /// 双帧编排入口：先算旧自动红圈锚点（逐像素复刻 UpdateTreeMark 口径），
        /// 再交给 DualFrameEngine 走回退链；任何异常都转 Fallback(Exception)，不抛到 UI。
        /// </summary>
        DualFrameResult PrepareDualFrame(UtmTree t, FrameInfo fiA, double azA, double elA,
                                         double photoBearing, double photoElevation)
        {
            double cal = 0.0;
            double H = 0.0;
            double azOld = 0.0;
            double elOld = 0.0;
            double camAX = 0.0, camAY = 0.0, camAZ = 0.0;
            DualFrameContext ctx = null;
            DualFrameInput input = null;
            try
            {
                if (t == null || fiA == null) return MinimalFallback(t, fiA, azOld, elOld, H);
                cal = (double)_cal;
                H = t.Height;
                if (string.IsNullOrEmpty(_dataSetId)) _dataSetId = DataSetIdOf(AppPaths.TreePath);

                double[] mpA = null;
                if (_metaPose != null) _metaPose.TryGetValue(fiA.Name, out mpA);
                if (mpA != null && mpA.Length >= 6)
                {
                    camAX = mpA[0]; camAY = mpA[1]; camAZ = mpA[2];
                }

                // 旧自动锚点：与 UpdateTreeMark 中 TrunkMarkH + TrunkAxisUtm 完全同口径。
                double tux = t.X, tuy = t.Y;
                bool hasTrunk = TrunkAxisUtm(t, out tux, out tuy);
                double d0;
                UtmForest.TreeAzim(tux, tuy, t.Z + TrunkMarkH(H), camAX, camAY, camAZ,
                                   out azOld, out elOld, out d0);
                if (!hasTrunk)
                {
                    // 与 UpdateTreeMark 的单帧基点一致；2.7° 只用于兼容已有人工标注。
                    azOld = Geo.Wrap360(azA + (HasManualMark(t.Id) ? TrunkAzBias : 0.0));
                }

                int indexA = -1;
                if (_frames != null)
                {
                    for (int i = 0; i < _frames.Frames.Count; i++)
                    {
                        if (string.Equals(_frames.Frames[i].Name, fiA.Name, StringComparison.OrdinalIgnoreCase))
                        {
                            indexA = i;
                            break;
                        }
                    }
                }

                FrameCandidate candA;
                List<FrameCandidate> cands = BuildDualFrameCandidates(t, cal, indexA, out candA);
                if (candA == null && mpA != null && mpA.Length >= 6 && indexA >= 0)
                {
                    bool dummy;
                    candA = MakeDualFrameCandidate(t, mpA, indexA, cal, out dummy, true);
                }

                ctx = new DualFrameContext
                {
                    Frames = _frames == null ? new List<FrameInfo>() : _frames.Frames,
                    MetaPose = _metaPose,
                    Cal = cal,
                    CalV = (double)_calV,
                    PhotoBearing = photoBearing,
                    PhotoElevation = photoElevation,
                    LevelView = _levelView,
                    ProjectionD = Proj.NaturalD,
                    DataSetId = _dataSetId,
                    Enabled = (_dualFrameEnabled),
                    Manual = HasManualMark(t.Id),
                    // 独立解码缩图，不与 PanoramaRenderer 后台线程争用 _curFrame 的 GDI+ 位图。
                    LoadSmallFrame = delegate(string nm)
                    {
                        return DualFrameImageEvidence.LoadSmallFrame(_frames, nm);
                    },
                    // 当前实现不缓存缩图：主帧一次，辅助帧最多三次。
                    IsFrameCached = delegate(string nm) { return false; },
                    TrunkAxisOf = delegate(UtmTree tt)
                    {
                        double x, y;
                        bool ok = TrunkAxisUtm(tt, out x, out y);
                        return ok ? new double[] { x, y } : null;
                    },
                    ProjectPrimary = CreatePrimaryPhotoProjector(t, mpA, photoBearing, photoElevation),
                    AxisConflictsNeighbor = AxisConflictsNeighbor,
                    ObservationAtOperatorRisk = ObservationAtOperatorRisk,
                    TrunkMarkHOf = delegate(double h) { return TrunkMarkH(h); },
                    OcclusionOf = delegate(UtmTree tt, double[] mpx, double dhx)
                    {
                        UtmTree aim = AimTrunk(tt);
                        // dhx 基于树干轴心，射线方向也必须用同一水平坐标。
                        double x, y;
                        TrunkAxisUtm(tt, out x, out y);
                        aim.X = x;
                        aim.Y = y;
                        return CountOcclusion(tt, mpx, aim, dhx);
                    },
                    // DEF-04：架次段 ID 判据（替代 A/B GPS 差 ≤600s）。
                    SegmentOf = delegate(string nm) { return FlightSegmentOf(nm); },
                    Log = delegate(string s) { BackendLog.Write(s); }
                };

                input = new DualFrameInput
                {
                    Tree = t,
                    FrameA = fiA,
                    CandA = candA,
                    Candidates = cands,
                    AzA = azA,
                    ElA = elA,
                    AzOld = azOld,
                    ElOld = elOld,
                    Cache = _dualFrameCache
                };

                bool cacheHit;
                int loads;
                DualFrameResult r = DualFrameEngine.Prepare(ctx, input, out cacheHit, out loads);
                _dualFrameCur = r;
                if (!cacheHit)
                {
                    int treeCount = (_utmForest == null) ? 0 : _utmForest.Trees.Count;
                    DualFrameEngine.WriteReplay(r, t.Id, _dataSetId, cal, (double)_calV, treeCount);
                    if (r.Status == DualFrameStatus.Success || r.Status == DualFrameStatus.Fallback)
                    {
                        BackendLog.Write("双帧 树" + t.Id.ToString(CultureInfo.InvariantCulture)
                            + " A=" + r.FrameA
                            + " B=" + (string.IsNullOrEmpty(r.FrameB) ? "-" : r.FrameB)
                            + " 基线角=" + r.BaselineAngleDeg.ToString("F1", CultureInfo.InvariantCulture)
                            + " 残差=" + r.ResidualM.ToString("F2", CultureInfo.InvariantCulture) + "m"
                            + " 置信度=" + r.Confidence.ToString("F2", CultureInfo.InvariantCulture)
                            + " dAz=" + r.Fusion.DAzA.ToString("F1", CultureInfo.InvariantCulture)
                            + "/" + r.Fusion.DAzB.ToString("F1", CultureInfo.InvariantCulture)
                            + " dEl=" + r.Fusion.DElA.ToString("F1", CultureInfo.InvariantCulture)
                            + "/" + r.Fusion.DElB.ToString("F1", CultureInfo.InvariantCulture)
                            + " 几何一致性=" + r.Fusion.Agree.ToString("F2", CultureInfo.InvariantCulture)
                            + " 状态=" + r.Status + " 原因=" + r.Reason
                            + " 高度=" + r.HeightM.ToString("F2", CultureInfo.InvariantCulture) + "m"
                            + " 限幅=" + r.LimitClamped
                            + " 辅帧尝试=" + r.PairAttempts.ToString(CultureInfo.InvariantCulture)
                            + " 读图=" + loads.ToString(CultureInfo.InvariantCulture)
                            + " 缓存=未命中");
                    }
                }
                return r;
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 树" + (t == null ? 0 : t.Id).ToString(CultureInfo.InvariantCulture)
                            + " 异常转回退: " + ex);
                DualFrameResult r;
                try
                {
                    r = (ctx != null && input != null)
                        ? DualFrameEngine.MakeFallback(ctx, input, FallbackReason.Exception,
                                                       0.0, "", 0.0, 0.0)
                        : MinimalFallback(t, fiA, azOld, elOld, H);
                }
                catch (Exception)
                {
                    r = MinimalFallback(t, fiA, azOld, elOld, H);
                }
                _dualFrameCur = r;
                return r;
            }
        }

        /// <summary>
        /// 异常兜底：仍给出可用的旧锚点，保证「不留空标注」。
        /// DEF-02：异常树统一走 FallbackHeight，避免矮树高度跌破 0.8m。
        /// </summary>
        static DualFrameResult MinimalFallback(UtmTree t, FrameInfo fiA,
                                               double azOld, double elOld, double H)
        {
            var r = new DualFrameResult();
            r.Status = DualFrameStatus.Fallback;
            r.Reason = FallbackReason.Exception;
            r.FrameA = fiA == null ? "-" : fiA.Name;
            r.FrameB = "";
            r.BaselineAngleDeg = 0.0;
            r.ResidualM = 0.0;
            r.Confidence = 0.0;
            r.AzOld = azOld;
            r.ElOld = elOld;
            r.AzNew = azOld;
            r.ElNew = elOld;
            r.HeightM = DualFrameGeometry.FallbackHeight(H, TrunkMarkH(H));
            r.LimitClamped = false;
            return r;
        }
    }
}
