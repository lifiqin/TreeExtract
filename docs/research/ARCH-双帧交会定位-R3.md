# ARCH｜双帧交会定位 R3 增量修订设计（相对偏差一致性融合）

> **文档类型**：R3 增量修订设计（仅设计，不含实现代码、不改动源码）
> **上游**：`docs\research\PRD-双帧交会定位.md`、`docs\research\ARCH-双帧交会定位.md`（初版）、R1/R2 实现与 QA 回放、team-lead R3 定案
> **适用**：`E:\树木识别\TreeExtract`，C# / .NET Framework 4.x / WinForms，**C# 5 语法、零新增依赖**
> **口径优先级**：team-lead R3 定案 > 本文 > 初版 ARCH > PRD。凡冲突均在 §12 显式列出。
> **作者**：高见远（架构师）

---

## 1. R3 一句话与根因采信

**一句话**：把 R2 的「两条量测射线做 3D 绝对最近点交会」改为「**双帧相对观测一致性融合**」——每帧在收紧 ROI + 中心先验下量出树干轴心的角度，与各自理论锚点角度求偏差 `dAz/dEl`，用两帧偏差的一致性 `agree` 判定可信度，再把加权平均偏差经 5°/6° 限幅叠加到**主帧 A 的理论锚点**上；同向姿态系统误差在偏差差值里抵消、在共同项里保留（与渲染口径自洽），不再要求两射线 3D 相交。

**根因（直接采信 team-lead 诊断，不重新排查）**：R2 调参后真双帧 Success 覆盖率 D1≈3% / D2≈1.5% / D3≈5.7%，`ObservationFailed + ResidualTooLarge` 占 92%，残差样本达 3.18 m。根因不是阈值，而是 ① ROI 半宽近树可达 50°+ 混入多树干/阴影；② 取 ROI 全局最大峰、无「靠近理论树方位」先验；③ 两条独立误差射线做绝对 3D 交会必然不相交、且 `s1/s2<=0` 与残差 >1.2 m 双硬拒；④ 反投影符号/坐标系**正确**（`TrunkObservation.cs:229` 与 `MainForm.Photo.cs:88` 同口径），**不得往此方向改**；⑤ D2/D3 姿态由 IMU Heading 生成，方位基准含对所有帧同向的系统误差，绝对交会无法抵消，相对偏差可以。

---

## 2. R2 → R3 差异表

| 维度 | R2（现状） | R3（修订） | 影响文件 |
|---|---|---|---|
| 定位原理 | 两射线 3D 最近点绝对交会，取 `pMid.X/Y` 投影回 A | **角度域相对偏差一致性融合**，无 3D 交会 | Geometry / Engine |
| 观测输出 | `Measure` 只出 `ray, zBot, zTop, quality` | 新增 `MeasureEx` 出 `AzPix/ElPix/PeakContrast/PeakOffsetRatio` + 保留 `Ray`（诊断） | Observation / Types |
| 理论基准 | 无（只有 `c.AzT` 用于 ROI 定位） | 新增 `azTheory = Wrap360(c.AzT)`、`elTheory = atan2(t.Z+Hmark−mp[2], c.Dh)` | Geometry / Engine |
| 一致性判据 | `residualM ≤ 1.2 m` 硬回退 | `agree = exp(−|ΔdAz|/σAz)·exp(−|ΔdEl|/σEl)`；**残差仅诊断，不再回退** | Geometry / Engine |
| 退化拒判 | `Intersect` 失败（`s1/s2<=0`、近似平行）即 `ObservationFailed` | `Intersect` 保留为诊断函数，Prepare **不再调用它判失败** | Engine |
| 可见段 | `zHigh<zLow` 直接 `ObservationFailed` | `zHigh<zLow` **降级**为 `HeightFallback(H)` 继续融合（不判失败） | Engine |
| 锚点公式 | `TreeAzim(pMid.X,pMid.Y,t.Z+hm, mpA, …)` | `azNew = Wrap360(azTheoryA + Clamp(w·dAzA+(1−w)·dAzB, ±5°))`；`elNew = Clamp(elTheoryA + Clamp(w·dElA+(1−w)·dElB, ±6°))` | Geometry / Engine |
| ROI 半宽 | `max(1.5, 0.5·|ElT−ElB|)`，无上限 | `Clamp(0.5·|ElT−ElB|, 3.0, 20.0)` 度 | Config / Observation |
| 峰定位 | ROI 全局 `max(col)` | 列剖面乘中心高斯先验后取峰；`|uStar−cx| > 0.6·rw` 钳边界 + quality 折减 | Observation / Config |
| quality | `0.50·对比度 + 0.35·段长 + 0.15·遮挡` | 追加「峰到中心距离」因子（4 项加权和，权重重配） | Config / Observation |
| 置信度 | `0.35·fResid + 0.25·fBase + 0.25·minQ + 0.15·pose` | `0.40·agree + 0.25·minQ + 0.20·fBase + 0.15·pose`，`fBase` 分母 `(50−15)` | Config / Geometry |
| ConfMin | 0.42 | **保持 0.42**（初值，可离线标定） | Config |
| 限幅折减 | 0.9 | **保持 0.9** | Config |
| 回退链 / 高度 | 四态、HeightSuccess/HeightFallback、DEF-02 矮树 | **完全不变** | — |
| 硬约束（A 帧 / 选帧 / 缓存 / 读图 / 启动） | — | **全部不变** | — |

---

## 3. A. 核心算法：双帧相对观测一致性融合

### 3.1 新增数据结构（`src\DualFrame\DualFrameTypes.cs`）

```csharp
// 一帧图像量测的完整结果。Ray 仅为诊断（求残差日志），不参与定位。
internal struct TrunkMeasure {
    public double AzPix, ElPix;      // 量测得到的世界角（度），与 c.A0/cal 同一角度空间
    public double ElTop, ElBot;      // 可见段上下界对应世界仰角（度）
    public double ZBot, ZTop;        // 可见段换算成相对树底 t.Z 的高度（米）
    public double Quality;           // [0,1] 综合质量（已含「峰到中心距离」因子）
    public double PeakContrast;      // [0,1] 归一化峰对比度，供融合权重 w
    public double PeakOffsetRatio;   // |uStar − cx| / rw，诊断与 quality 用
    public Ray3   Ray;               // 仅诊断：Intersect 求 residualM
}

// R3 诊断量（写入 DualFrameResult，供日志/回放 CSV/离线扫参）
internal struct FusionDiagnostics {
    public double DAzA, DAzB, DElA, DElB;   // 两帧相对偏差（度）
    public double Agree;                     // 一致性 [0,1]
    public double WeightA;                   // w（A 帧融合权重）[0,1]
    public double ResidualM;                 // 诊断残差（米），不再作回退判据
}
```

`DualFrameResult` 追加字段：`public FusionDiagnostics Fusion;`；`ResidualM` 保留（值由诊断交会填入），`HeightM` 语义不变。

### 3.2 量测层接口（`src\DualFrame\TrunkObservation.cs`）

```csharp
// R3 新签名：Engine 统一改调此入口
public static bool MeasureEx(Bitmap small, UtmTree t, FrameCandidate c,
                             double[] mp, double cal, out TrunkMeasure m);

// 原 Measure(...) 保留为薄包装：内部调 MeasureEx 并映射旧 out 参数，
// 保证遗留调用不破；R3 起 Prepare 不再使用它。
public static bool Measure(Bitmap small, UtmTree t, FrameCandidate c, double[] mp, double cal,
                           out Ray3 ray, out double zBot, out double zTop, out double quality);
```

`AzPix = Geo.Wrap360(c.A0 + (uStar/W)·360)`、`ElPix = Geo.Clamp(90 − (vMid/H)·180, −85, 85)`，**口径与 R2 `:229` 完全一致，不得改符号/坐标**（team-lead 诊断 ④）。`m.Ray` 仍按 R2 `:232-238` 构造，仅用于诊断。

### 3.3 理论基准与偏差（`src\DualFrame\DualFrameGeometry.cs`）

```csharp
// 该帧「理论树干锚点」仰角（度）。dh 用 c.Dh（相机到树心水平距离），与 azTheory=c.AzT 同一柱。
public static double TheoryElevation(UtmTree t, double[] mp, double dh, double hMark);
    // Geo.Deg(Math.Atan2((t.Z + hMark) − mp[2], Math.Max(0.5, dh)))
    // 与 MakeDualFrameCandidate 的 elA/elB/elT（MainForm.DualFrame.cs:220-222）同口径，
    // 用 Atan2 而非 Atan 仅为数值稳健（dh 恒正，二者等价）。

// 单帧偏差：dAz 用 Wrap180 处理跨 0°；dEl 为直接差。
public static void Deviations(TrunkMeasure m, double azTheory, double elTheory,
                              out double dAz, out double dEl);
    // dAz = Geo.Wrap180(m.AzPix − Geo.Wrap360(azTheory));   dEl = m.ElPix − elTheory;
```

**`azTheory` 统一取 `Geo.Wrap360(candA.AzT / candB.AzT)`**（`MainForm.DualFrame.cs:216` 的理论树方位，即 team-lead 公式中的 `azTA`）。

> **关键澄清（防止工程师误改）**：`azPix` 量自**图像树干轴心**，因此 `dAz` 已隐含「干心相对树心的横向偏移」，不会丢失 R2 中 `TrunkAxisUtm` 的干心修正效果；不要改用 `AzOld`（旧自动锚点）作 `azTheory`，否则重复叠加干心偏移。旧自动锚点 `AzOld/ElOld` 在 R3 只用于**限幅前的对照、Disabled/ManualSkipped 两态、日志/CSV 列**，不进入融合基准。

### 3.4 一致性 `agree`

```csharp
public static double Agreement(double dAzA, double dElA, double dAzB, double dElB);
    // Math.Exp(−Math.Abs(Geo.Wrap180(dAzA − dAzB)) / DualFrameConfig.AgreeSigmaAzDeg)
    // * Math.Exp(−Math.Abs(dElA − dElB) / DualFrameConfig.AgreeSigmaElDeg)
    // 建议初值 σAz=6°、σEl=8°（写入 Config，供离线标定）。
```

两帧同向姿态系统误差 ε 在 `Wrap180(dAzA−dAzB)` 中相消；作为共同项保留在 `Δ` 里是**必要且正确**的——画面渲染同样经 `PanoAzimuthFromOpk + cal`，锚点必须与之同处一个含 ε 的角度空间，红圈才会落在树干实际像素上。

### 3.5 融合权重、修正量与限幅

```csharp
// A 帧权重，由两帧 quality / 峰对比度加权；钳制防退化。
public static double FusionWeight(TrunkMeasure mA, TrunkMeasure mB);
    // wA = Math.Max(1e−6, mA.Quality * mA.PeakContrast);
    // wB = Math.Max(1e−6, mB.Quality * mB.PeakContrast);
    // return Geo.Clamp(wA / (wA + wB), FuseWeightAMin /*0.2*/, FuseWeightAMax /*0.8*/);

public static void FuseRelative(double azTheoryA, double elTheoryA,
        double dAzA, double dElA, double dAzB, double dElB, double w,
        out double azNew, out double elNew, out bool clamped);
    // dAzF = w*dAzA + (1−w)*dAzB ;  cAz = Geo.Clamp(dAzF, −LimitAzDeg, +LimitAzDeg);
    // dElF = w*dElA + (1−w)*dElB ;  cEl = Geo.Clamp(dElF, −LimitElDeg, +LimitElDeg);
    // clamped = (|cAz−dAzF|>1e−9 || |cEl−dElF|>1e−9)
    // azNew = Geo.Wrap360(azTheoryA + cAz);
    // elNew = Geo.Clamp(elTheoryA + cEl, −90.0, 90.0);
```

`Limit` 原函数保留但 `Prepare` 不再调用（融合内部已限幅），避免二次截断；或改为内部转调 `FuseRelative`，由架构师定，本文取**前者**（保留不用）。

### 3.6 高度（不变，但顺序前移）

```
zLow = max(mA.ZBot, mB.ZBot);  zHigh = min(mA.ZTop, mB.ZTop);
Hmark = (zHigh >= zLow) ? DualFrameGeometry.HeightSuccess(0.5*(zLow+zHigh), H)
                        : DualFrameGeometry.HeightFallback(H);     // R3 降级，不判失败
```

`Hmark` **必须同时**用于：① 两帧 `TheoryElevation(..., Hmark)`；② `DualFrameResult.HeightM`；③ 日志/CSV 高度列。`UpdateTreeMark` 只消费 `AzNew/ElNew`（`MainForm.Frames.cs:234-239` 已确认），**不会**用 `HeightM` 反算角度——因此若 `HeightM` 与 `elTheory` 用了不同 Hmark，会出现「CSV 显示居中但红圈仍靠下」的自相矛盾，列为一致性审查项。矮树 DEF-02（`FallbackHeight` / `CeilOf` / `IsAbnormalHeight`）保持不动；失败态仍走 `FallBackHeight(H, legacyH)`，不得回退旧低高度。

### 3.7 残差降级为诊断

```csharp
// 保留原签名与实现，但 Prepare 不再用它判失败（移除 :289-294 的硬回退）。
public static bool Intersect(Ray3 a, Ray3 b, out Vec3 pMid, out double residualM);  // 诊断专用
```

引擎在成功与失败两态都可以调用一次 `Intersect` 填 `r.ResidualM`/`r.Fusion.ResidualM`（调用失败填 `NaN` 或 0，不判失败）；`ResidualMaxM` 常量保留，`ResidualTooLarge` 枚举保留但**R3 不再产生该原因**（兼容历史 CSV 解析）。`FallbackReason.ObservationFailed` 仅由「量测读图失败 / 峰对比度 < 0.06 / quality ≤ 0」触发。

### 3.8 置信度（C，替换现有公式）

```csharp
// 新签名：fResid 参数移除
public static double Confidence(double agree, double qA, double qB,
                                double baselineDeg, double poseIntegrity);
    // fBase = Geo.Clamp((baselineDeg − 15) / (50 − 15), 0, 1)
    // return Geo.Clamp(ConfW[0]*agree + ConfW[1]*Math.Min(qA,qB)
    //                + ConfW[2]*fBase + ConfW[3]*poseIntegrity, 0, 1);
    // ConfW = {0.40, 0.25, 0.20, 0.15}
```

`poseIntegrity` 沿用 R2 `PoseIntegrityOf(mpA,mpB)`：IMU 0.8 / OPK 1.0 取 min（`DualFrameGeometry.cs:64-75`），不改。限幅触发 `conf *= LimitConfFold(0.9)`；`conf < ConfMin(0.42)` 才 `Fallback(LowConfidence | LimitExceeded)`。

---

## 4. B. 量测鲁棒化（`TrunkObservation.cs`）

| # | 改动 | 公式 / 实现口径 |
|---|---|---|
| B1 | ROI 半宽收紧 | `:64` 改 `winDeg = Geo.Clamp(RoiHalfWidthRatio*Abs(c.ElT−c.ElB), RoiMinWinDeg=3.0, RoiMaxWinDeg=20.0)`；`rw = Ceil(winDeg/360*W)`，保留 `rw≥8`、`rw≤W/4`。消除近树 50°+ 窗口混入多树干/阴影 |
| B2 | 中心高斯先验 | `:139` 列剖面归一化后，逐列乘 `prior(i) = exp(−0.5*((i − cols/2)/(CenterPriorSigma*cols/2))^2)`，`CenterPriorSigma=0.35`；`peakIdx` 在**加权后**的 `col[]` 上取。峰倾向理论树方位 `cx`（ROI 中心） |
| B3 | uStar 越界处理 | 令 `off = Abs(uStar − cx)`；若 `off > UStarMaxRatio(0.6)*rw`：**钳到边界** `uStar = cx ± 0.6*rw`，`PeakOffsetRatio = 0.6`（不判失败），并把 `quality` 乘 `UStarFold=0.7`。**定案选「钳制+折减」而非判 ObservationFailed**：R3 首要目标是提覆盖率，钳制后仍可由 `agree`/`ConfMin` 把关；直接判失败会把近树重新打回低覆盖率（R2 教训）。理由写入代码注释 |
| B4 | quality 增加中心距离因子 | `centerFactor = exp(−0.5*(off/(CenterPriorSigma*rw))^2)`；`quality = Clamp(QualityWContrast*contrast + QualityWSegment*segRatio + QualityWOcclusion*occFactor + QualityWCenter*centerFactor, 0, 1)`，4 权重归一（建议 `0.40/0.25/0.15/0.20`，可在离线标定后微调）。R2 加权和形式保留，仅增项 |
| B5 | 峰对比度下限 | `PeakContrastMin=0.06` **保持不变**；`PeakContrastScale=0.20` 不变；`contrast` 同时写入 `m.PeakContrast` |
| B6 | 输出扩展 | `MeasureEx` 额外填 `AzPix/ElPix/ElTop/ElBot/PeakContrast/PeakOffsetRatio`，`Ray` 按 R2 原样构造；读图张数不变（A/B 各 1 张，≤2 张/树） |

> **不得改动**：`azPix` 反投影表达式、ROI 列中心 `cx`、全景拼缝列环绕、`zBot/zTop` 换算、`LockBits` 采样、可见段最长连续段判定（team-lead 诊断 ④）。

---

## 5. C. 置信度（配置化）

`Conf = 0.40·agree + 0.25·min(qA,qB) + 0.20·f_base + 0.15·poseIntegrity`
`f_base = Clamp((baseline − 15)/(50 − 15), 0, 1)`；`BaselineSatDeg = 50` 沿用。
限幅触发 `Conf *= 0.9`；`Conf < 0.42` → Fallback。**所有权重走 `DualFrameConfig.ConfW`，禁止硬编码**。

---

## 6. `DualFrameConfig.cs` 参数增改全表

| 参数 | R2 值 | R3 值 | 说明 |
|---|---|---|---|
| `AgreeSigmaAzDeg` | — | **6.0** | 新增，一致性方位尺度（度） |
| `AgreeSigmaElDeg` | — | **8.0** | 新增，一致性仰角尺度（度） |
| `RoiMinWinDeg` | — | **3.0** | 新增，ROI 半宽下限（度） |
| `RoiMaxWinDeg` | — | **20.0** | 新增，ROI 半宽上限（度） |
| `CenterPriorSigma` | — | **0.35** | 新增，中心高斯先验 σ（×cols/2） |
| `UStarMaxRatio` | — | **0.6** | 新增，uStar 相对 rw 的最大偏移 |
| `UStarFold` | — | **0.7** | 新增，越界钳制后的 quality 折减 |
| `QualityWCenter` | — | **0.20** | 新增，quality 中心距离因子权重 |
| `QualityWContrast/Segment/Occlusion` | 0.50/0.35/0.15 | **0.40/0.25/0.15** | 重配以容纳第 4 项（和为 1） |
| `FuseWeightAMin / FuseWeightAMax` | — | **0.2 / 0.8** | 新增，w 钳制边界 |
| `ConfW` | {0.35,0.25,0.25,0.15} | **{0.40,0.25,0.20,0.15}** | 语义改为 agree/minQ/fBase/pose |
| `ConfMin` | 0.42 | **0.42** | 保持（离线标定可扫） |
| `LimitConfFold` | 0.9 | **0.9** | 保持 |
| `ResidualMaxM` | 1.2 | **1.2（保留）** | **降级为诊断**，不再作回退判据 |
| `PeakContrastMin` / `PeakContrastScale` | 0.06 / 0.20 | **不变** | B5 明确保留 |
| `RoiHalfWidthRatio` | 0.5 | **0.5（不变）** | 由 B1 的 clamp 收口 |
| `BaselineAngleMinDeg` / `BaselineSatDeg` | 15 / 50 | **不变** | 硬约束 |
| `FlightGapSec` | 180 | **不变** | 同架次段判据 |
| `LimitAzDeg` / `LimitElDeg` | 5 / 6 | **不变** | 融合内部限幅 |
| `HeightK/FloorM/CeilRatio/CeilAbsM/HeightAbnormalMaxM` | 0.12/0.8/0.35/2.0/80 | **全部不变** | DEF-02 保持 |
| `MaxExtraFrameLoads` / `RoiSmallW/H` | 2 / 1440×720 | **不变** | 性能硬约束 |
| `PoseIntegrityFull/Imu/PoseImuEpsilon` | 1.0/0.8/1e−6 | **不变** | |
| `SelectWBase/SelectWQuality/SelectOccPenalty` | 0.6/0.4/0.3 | **不变** | SelectB 不动 |
| `NearPoolFactor/P1WideFactor/CandidateMinDhM/MaxDhM/BaselineLenRatio` | — | **不变** | P1-1 不动 |
| `ReplayCsvRelative` | `outputs\双帧交会回放.csv` | **不变** | 全量覆写逻辑保持 |

> 新增/改动参数**全部集中于此文件**；`TrunkObservation.cs` / `DualFrameGeometry.cs` / `DualFrameEngine.cs` 不得出现数值字面量（除 0/1/2、1e−6 等结构常量）。

---

## 7. 调用流程（R3）

```mermaid
sequenceDiagram
    participant R as Recompute(refine=true)
    participant P as PrepareDualFrame (MainForm.DualFrame.cs)
    participant E as DualFrameEngine.Prepare
    participant B as SelectB (B1–B6 不变)
    participant O as TrunkObservation.MeasureEx
    participant G as DualFrameGeometry (R3 新公式)
    participant U as UpdateTreeMark
    participant S as AppendDualFrameStatus / CSV

    R->>P: PrepareDualFrame(t, fiA, azA, elA) 仅 refine=true 路径
    P->>P: 旧锚点 AzOld/ElOld（TrunkMarkH+TrunkAxisUtm， Disabled/Manual 用）
    P->>E: Prepare(ctx, input)
    E->>E: 开关/人工/缓存/树高异常 命中即停（不变）
    E->>B: SelectB → B + baselineDeg（架次段/15°/6DOF/读图≤2，不变）
    E->>O: MeasureEx(A) / MeasureEx(B)
    Note over O: B1 ROI clamp 3~20° · B2 中心先验 · B3 uStar 钳制 · B4 quality +中心因子
    O-->>E: TrunkMeasure{AzPix,ElPix,ZBot,ZTop,Quality,PeakContrast,Ray} ×2
    E->>G: (可选诊断) Intersect(rayA,rayB) → residualM，不判失败
    E->>G: Hmark = HeightSuccess(zMidCommon,H) 或 HeightFallback(H)
    E->>G: elTheoryA/B = TheoryElevation(t,mp,dh,Hmark)
    E->>G: Deviations ×2 → dAzA,dElA,dAzB,dElB
    E->>G: Agreement → agree ; FusionWeight → w
    E->>G: FuseRelative(azTheoryA,elTheoryA,偏差,w) → azNew,elNew,clamped
    E->>G: Confidence(agree,qA,qB,baseline,pose) → conf (×0.9 若限幅)
    alt conf < ConfMin 或 量测失败
        E-->>R: Fallback(新居中高度 + TrunkAxisUtm 横向，DEF-02 保持)
    else
        E-->>R: Success(AzNew,ElNew,HeightM,Conf,Fusion 诊断)
    end
    R->>U: Success/Fallback 两态覆盖 _autoAzTrunk/_autoElTrunk；人工偏移仍由 ApplyMarkOffset 叠加
    R->>R: RefreshCrop / 4:3 / 识别 / 热力图（全以主帧 A，不变）
    R->>S: _statusLbl 覆写后追加状态串；写日志「双帧 」；回放 CSV 全量覆写
```

**触发约束不变**：仅 `refine=true` 选中树路径；`AutoSelectStartupTree`（`refine=false`）零调用、零新增读图、零「双帧 」日志。

---

## 8. 修改文件清单与插入点

| # | 文件 | 类型 | 插入点 / 改动 |
|---|---|---|---|
| 1 | `src\DualFrame\DualFrameConfig.cs` | 改 | §6 全表：新增 10 个参数、改 `ConfW`/`QualityW*`，**`ResidualMaxM` 注释改为「仅诊断」** |
| 2 | `src\DualFrame\DualFrameTypes.cs` | 改 | 新增 `TrunkMeasure` / `FusionDiagnostics`；`DualFrameResult` 加 `Fusion` 字段；`StatusText` 文案改「双帧融合成功」/「双帧融合成功（已限幅）」（`DualFrameStatus` 枚举与 CSV 英文 `Status` 列**不变**）；`ReasonText` 的「交会残差过大」标注为「R2 遗留，R3 不再产生」 |
| 3 | `src\DualFrame\TrunkObservation.cs` | 改 | 新增 `MeasureEx`；原 `Measure` 改薄包装；`:64` ROI clamp；`:139` 列剖面乘先验；`:147-153` 在加权后剖面取峰；`:172` 后 uStar 钳制；`:214-224` quality 加中心因子；`:226-238` 填 `AzPix/ElPix/PeakContrast/PeakOffsetRatio` + 保留 `Ray` |
| 4 | `src\DualFrame\DualFrameGeometry.cs` | 改 | 新增 `TheoryElevation` / `Deviations` / `Agreement` / `FusionWeight` / `FuseRelative`；`Confidence` **改签名**（去 `residualM`，加 `agree`，权重换 `ConfW`）；`Intersect` 注释降级为「诊断专用」但**实现不动**；`Limit` 保留不调；`HeightSuccess/HeightFallback/FallbackHeight/CeilOf/IsAbnormalHeight/PoseIntegrityOf` **零改动** |
| 5 | `src\DualFrame\DualFrameEngine.cs` | 改 | `Prepare` `:269-340` 段重写：`Measure`→`MeasureEx`；**删除 `:289-294` 的 Intersect 失败 + `residualM>1.2` 硬回退**（改为可选诊断调用）；`:296-305` `zHigh<zLow` 由判失败改为 `HeightFallback` 降级；新增 `Hmark → elTheory → Deviations → Agreement/FusionWeight → FuseRelative` 链；`:307-310` 的 `TreeAzim(pMid...)` **删除**；`Confidence` 调用换参；`FusionDiagnostics` 填入结果；`:316-322` 限幅折减与 `ConfMin` 判定保持；`FallbackReason.ResidualTooLarge` 不再产生；`BuildReplayLine` 表头**行尾追加** `dAzA,dAzB,dElA,dElB,agree,w,诊断残差`（前 14 列顺序不变，兼容旧解析器），`ResetReplay` / `InvalidateReplayTree` / `WriteReplay` / `FlushReplayFile` **全量覆写逻辑零改动** |
| 6 | `src\MainForm.DualFrame.cs` | **可选改** | 仅在需要把 `Hmark`/`candA.AzT` 显式传入 `DualFrameInput` 时补字段（当前 `input.CandA` 已含 `AzT/Dh`，`ctx.MetaPose` 已含 `mpA/mpB`，**预计无需改**）；日志追加 `dAz/dEl/agree/w` 诊断值；`PrepareDualFrame` 前段 `:268-318` **零改动** |
| — | `src\MainForm.Frames.cs` / `Ui.cs` / `Data.cs` / `MarkStore.cs` / `Photo.cs` / `FrameQuality.cs` / `Geometry.cs` / `Proj.cs` / `build.ps1` | **零改动** | 硬约束：主帧 A / PickFrameUtm / RefineFrameChoice / AutoSelectStartupTree / 4:3 / 切图 / 识别 / 热力图 / 缓存键 / manual_marks.csv |

---

## 9. 给工程师的有序任务列表

> 5 个任务；T01 先落签名，T02/T03 仅依赖签名可并行；**共享文件按任务顺序增量修改，禁止两个任务同时写同一文件**。

| ID | 任务名 | 主改文件 | 参照/核对文件 | 依赖 | 优先级 | 验收点 |
|---|---|---|---|---|---|---|
| **T01** | 参数与类型层 | `DualFrameConfig.cs`、`DualFrameTypes.cs` | `DualFrameGeometry.cs`（确认保留项签名） | — | P0 | 编译通过（C# 5）；§6 全部新参数落地且其它文件无数值字面量；`TrunkMeasure`/`FusionDiagnostics` 字段齐全；`DualFrameStatus` 枚举值与 CSV `Status` 列不变；`Intersect`/`Height*`/`PoseIntegrityOf` 签名与实现未被误删 |
| **T02** | 量测鲁棒化 + 输出扩展 | `TrunkObservation.cs` | `MainForm.DualFrame.cs:204-242`（AzT/A0/Dh 口径）、`Geometry.cs`（Wrap180/Clamp）、`DualFrameConfig.cs` | T01 | P0 | 单测：构造 50°+ 理论窗口的近树，实测 `rw` 对应 ≤20°；中心先验使峰落回 `cx` 邻域；`off>0.6rw` 时 uStar 被钳且 `quality` 折减 0.7；`PeakContrastMin=0.06` 仍生效；`AzPix/ElPix` 与 R2 旧射线反投影数值一致（**回归口径不漂**）；读图仍 2 张 |
| **T03** | 融合 / 一致性 / 置信度实现 | `DualFrameGeometry.cs` | `DualFrameConfig.cs`、`DualFrameTypes.cs`（签名）、`DualFrameEngine.cs`（调用点预判） | T01 | P0 | 数值自测：注入同向 ε（如两帧 `dAz` 同时 +10°）→ `agree≈1`（差值抵消）且 `Δ` 保留 ε；`FuseRelative` 限幅 5°/6° 严格不越界、`clamped` 标记正确；`Confidence` 与 `ConfW` 一致、`fBase` 分母为 35；`Intersect` 仍可调用且不再被 Prepare 用于判失败 |
| **T04** | 编排与回退链改造 | `DualFrameEngine.cs` | `DualFrameTypes.cs`（文案/诊断字段）、`MainForm.DualFrame.cs`（准备段，预计不改） | T01,T02,T03 | P0 | R2 中残差 3.18 m / `s1<=0` 的样本**不再**判 `ObservationFailed`/`ResidualTooLarge`；`zHigh<zLow` 降级 `HeightFallback` 而非回退；`Success` 覆盖率显著提升；Disabled/ManualSkipped 严格旧 `TrunkMarkH`；失败态新居中高度 + `TrunkAxisUtm` 横向不变；DEF-02 矮树不变；任何异常转 `Fallback(Exception)`；`_statusLbl` 追加仍在覆写后 |
| **T05** | 回放 / 日志 / 回归接线 | `DualFrameEngine.cs`（CSV 追加列）、`MainForm.DualFrame.cs`（日志诊断值） | `outputs\双帧交会回放.csv`、`docs\`（回归记录） | T04 | P1 | CSV 前 14 列顺序不变、行尾追加诊断列、全量覆写逻辑保持；状态栏 ↔ `双帧 ` 日志 ↔ CSV 三方一致；**Gate**：D1 Success ≥160/228(70%)、D2/D3 覆盖率报数并说明与 D1 差异、主帧零回归 100%、限幅不越界、矮树高度 ≥0.8 m、红圈 30%~80% 命中 ≥85%、启动 0 触发 0 读图 0 日志 |

**实现顺序**：T01 →（T02 ∥ T03）→ T04 → T05。

---

## 10. 离线标定建议（用 QA 回放 CSV 扫参）

R3 的 `agree` 与 `Conf` 只依赖 `dAzA/dAzB/dElA/dElB/基线角/qA/qB/pose`，**全部可从 T05 追加的诊断列离线重算**，无需重跑程序、无需重读图像：

1. **扫参网格**：`sigmaAz ∈ {3,4,6,8,12,16}°`、`sigmaEl ∈ {4,6,8,12,16}°`、`ConfMin ∈ {0.30,0.35,0.42,0.50}`，另可扫 `QualityWCenter ∈ {0.10,0.20,0.30}`、`UStarMaxRatio ∈ {0.5,0.6,0.8}`。
2. **目标函数**：主目标 D1 `Success ≥160/228`；约束（来自 PRD §8 / R3 Gate）「修正后误差反而增大」≤10%、红圈落 30%~80% 命中 ≥85%、草丛/枝杈 ≤5%、限幅不越界。**不要只优化覆盖率**——覆盖率上去了但 B1/B2 退化即为失败。
3. **分层统计**：按基线角 `15–25° / 25–40° / >40°` 分组画 `agree` 分布。若大基线组系统性偏低，原因是**视差**（干心 0.15 m 在两视角投影差可达 1~3°），可考虑 `sigmaAz` 随基线角线性放大（`AgreeSigmaAzPerBaseDeg`，可选新增 Config 项），或按组标定。
4. **数据集分层**：D2/D3 为 IMU 姿态，`poseIntegrity=0.8`，`ConfMin` 对它们更敏感。按数据集分别报数（R3 Gate 已允许 D2/D3 与 D1 有差异），**不要为拉齐 D3 而全局下调 `ConfMin`**。
5. **定参流程**：QA 出一版 CSV → 离线脚本扫出 Pareto 前沿 → 架构师与 QA 共同选定 → 工程师只改 `DualFrameConfig.cs` 常量 → 回归复跑确认。参数变更不改任何算法代码。

---

## 11. 工程师全局一致性审查清单（提交前逐条打勾）

**硬约束零回归**
- [ ] `PickFrameUtm` / `RefineFrameChoice` / `_refinedChoices` / `AutoSelectStartupTree` / `MakeDualFrameCandidate` / `BuildDualFrameCandidates` **函数体零改动**；主帧 A 帧名、dist/az/el 开/关 100% 一致（A1/R03）。
- [ ] 4:3 照片、竖版切图、树号烤字、`_cropClean`、热力图仍基于主帧 A；`RefreshCrop` 口径未动；融合结果只写 `_autoAzTrunk/_autoElTrunk`。
- [ ] `A≠B`、同架次段（`FlightGapSec=180`）、基线角 ≥15°、B 有 6DOF 姿态、B 满足原硬约束、读图 ≤2 张/树 —— `SelectB` / `ScanB` 零改动。
- [ ] 缓存键 `树Id+Cal+DataSetId` 不变；`LoadUtmData` 清缓存；启动 `refine=false` 零 Prepare、零读图、零「双帧 」日志（E1/R18）。
- [ ] 关闭开关 / 有 `manual_marks.csv` 记录 → 严格旧 `TrunkMarkH=clamp(0.042H,0.42,0.75)` + `TrunkAxisUtm`，9.13 逐项一致、7 棵历史人工树像素不漂移；CSV 格式语义零改（C1/C2/R10）。

**R3 算法口径**
- [ ] 观测角**只来自图像量测**；`azPix/elPix` 表达式与 R2 `:229` 完全一致，**未改反投影符号或坐标系**（team-lead 诊断 ④）。
- [ ] `azTheory = Wrap360(c.AzT)`，未误用 `AzOld`；`elTheory = atan2(t.Z+Hmark−mp[2], c.Dh)`；`Hmark` 同时用于 `elTheory`、`HeightM`、CSV 高度列（三者同一值）。
- [ ] `dAz` 用 `Wrap180`；`agree` 用 `Wrap180(dAzA−dAzB)`；`w` 有 `[0.2,0.8]` 钳制；限幅 5°/6° 在 `FuseRelative` 内一次性完成，**未二次调用 `Limit`**。
- [ ] **残差不再是回退判据**：`Prepare` 中不存在 `residualM > ...` 或 `Intersect(...)==false` 导致的 `return Fallback`；`ResidualTooLarge` 不再被赋值。
- [ ] `zHigh<zLow` 走 `HeightFallback` 降级、继续融合；失败态仍走 `FallbackHeight(H,legacyH)`，矮树 DEF-02 保持；高度不越 `min(0.35H,2.0)`、不低于 0.8 m（异常树除外）。
- [ ] `Confidence` 新签名、`ConfW={0.40,0.25,0.20,0.15}`、`fBase` 分母 35、限幅折减 0.9、`Conf<0.42` 才回退；所有阈值只在 `DualFrameConfig.cs`。

**可观测与兼容**
- [ ] CSV 前 14 列顺序不变、行尾追加诊断列、`ResetReplay/WriteReplay/FlushReplayFile` 全量覆写逻辑零改动。
- [ ] 状态串四要素齐全、位于 `_statusLbl.Text` 覆写之后；`双帧 ` 日志与 CSV 三方一致；「双帧融合成功」文案已更新但 `Status` 英文列仍为 `Success/Fallback`（QA Gate 计数不破）。
- [ ] 任何异常转 `Fallback(Exception)`，不抛到 UI、不留空标注；C# 5 语法（无表达式体成员、无字符串插值、无 `readonly struct`、无 `?.`），零新增依赖。

---

## 12. 与 PRD / 初版 ARCH 旧口径的冲突说明（**务必同步 QA**）

| # | 旧口径 | R3 定案 | 处置 |
|---|---|---|---|
| 1 | **PRD §6.2「基于 A/B 两帧相机中心与各自对树干的观测射线做交会，输出修正后的红圈锚点」**、§1「两射线最近点交会得水平位置」 | **已修订为「双帧相对观测一致性融合」**：不再做 3D 射线交会，改在角度域对 `dAz/dEl` 做一致性检验 + 加权平均 | 本文为口径修订的正式记录；QA 更新 §8-B1/B4 与 §10 中涉及「交会残差/基线」的判据描述。`Intersect` 保留为诊断函数，残差仅写日志/CSV |
| 2 | 初版 ARCH §4.2「水平位置取 `pMid.X/Y`，`residualM>0.6m` 判 `ResidualTooLarge`」；R2 提到 1.2 m | `ResidualMaxM` **降级为诊断**，不再判失败；`ResidualTooLarge` 枚举保留但不再产生 | QA 的 R13/R06 等用例中「残差过大回退」预期作废，改以 `LowConfidence` 归因 |
| 3 | 初版 ARCH §4.3 置信度含 `0.35·fResid` | R3 权重 `0.40·agree + 0.25·minQ + 0.20·fBase + 0.15·pose` | §8-B4「判为成功样本残差/基线角均达标」改为「`agree` 达标、限幅未越界」 |
| 4 | 初版 ARCH / R2 状态串「交会成功」 | 「双帧融合成功」/「双帧融合成功（已限幅）」 | 仅中文文案；`DualFrameStatus` 枚举与 CSV `Status` 列不变，避免破坏 QA 计数脚本 |
| 5 | 初版 ARCH §1 回退链第 3 步「回退到原 `TrunkMarkH` 锚点」（PRD §6.3 / §8-B4 同） | **沿用主理人 R1 定案**：仅「开关关闭 / 人工优先」用旧低高度；开关开启但失败用新居中高度 | 已在 R1 冲突表登记，R3 不变；QA 勿按 PRD 原文判 C3/B4 |
| 6 | PRD §9-Q9「CalV 是否进缓存键待确认」 | 已定案「不进键」，R3 不变 | R16 只记录结论 |
| 7 | PRD §9-Q2「D3 跨架次坐标系」 | R2 已用架次段 ID（`FlightGapSec=180`）切断；R3 `agree` 进一步容纳同向姿态误差 | R14 判据保持；D3 覆盖率单独报数，不与 D1 强求齐平 |
| 8 | 初版 ARCH §2.1 阈值表（0.6 m 残差、0.5 置信度、35° 饱和等） | 以 `DualFrameConfig.cs` 当前值 + §6 R3 表为准 | 初版 ARCH 仅作历史设计留档，实现与验收以本文 + Config 为准 |

---

## 13. 风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **视差伪不一致**：干心偏移在大基线两视角投影差 1~3°，`agree` 被压低 → 覆盖率上不去 | σAz/σEl 分层离线标定（§10 第 3 条）；必要时按基线角放大 σAz |
| R2 | 某帧 quality 虚高（背景柱体/阴影被误检）主导 `w` | 中心高斯先验 + uStar 钳制 + `w∈[0.2,0.8]` + `agree` 一致性共同把关；`PeakContrast` 参与权重 |
| R3 | `elTheory` 用 `c.Dh`（树心距），近树干心偏移使 `dEl` 带系统项 | 限幅 6° 兜底；σEl 可离线放宽；`agree` 只看两帧差值，同向项相消 |
| R4 | 「钳制+折减」而非判失败，可能让劣质量测混入 Success | `ConfMin=0.42` + 限幅折减 0.9 + B1 命中率 Gate 三重把关；若 QA 发现误接受增多，把 `UStarFold` 调到 0.5 或改判失败（**只改 Config**） |
| R5 | 状态串/CSV 文案与旧口径冲突导致 QA 误判 | §12 已列全；T05 验收前先与 QA 对齐 Gate 脚本 |
| R6 | T01–T05 共享文件（`DualFrameTypes.cs` / `DualFrameEngine.cs` / `MainForm.DualFrame.cs`）被并行写冲突 | 任务表已注明按序增量修改；T02/T03 并行时不碰同一文件 |
| R7 | C# 5 语法误用（表达式体、`?.`、字符串插值、`readonly struct`） | T01 验收点显式检查；新代码用 `delegate(...)` + `string.Format` + 显式 struct |

---

**交付说明**：本文仅为 R3 增量架构设计，未包含实现代码、未改动工程源码。请工程师按 §9 任务顺序实现，QA 按 §10 离线标定与 R3 Gate 建立回归基线。
