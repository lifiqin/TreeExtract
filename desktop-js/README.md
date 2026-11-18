# TreeExtract JavaScript 桌面界面

这是项目当前的 Windows 桌面客户端：交互和布局用 JavaScript、HTML、CSS 编写。C# 后端负责全景解码、坐标定位、投影、人工校正、ONNX 识别和对照表计算；它以无窗口的本地进程运行，通过单行 JSON 与 JavaScript 界面通信，不创建 WinForms 控件或隐藏窗口。后端已迁移到 .NET 10，并以自包含方式发布。项目总体入口、架构和维护流程见[项目首页](../README.md)、[系统设计](../docs/ARCHITECTURE.md)及[开发与发布](../docs/DEVELOPMENT.md)。

## 启动

### 直接运行 EXE

重复使用请运行 `release-net10/TreeExtract-frame-separation-20261117/TreeExtract.exe`：当前保留的目录版不需要 Node.js 或 .NET，也不需每次重新解压；移动或分享时须保留整个 `TreeExtract-frame-separation-20261117` 文件夹。全景 ZIP 和树木数据不包含在程序包中，换电脑时仍需另外提供。ONNX Runtime 在缺少 Microsoft Visual C++ 运行库的 Windows 上可能需要安装[官方 x64 运行库](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist)；未签名程序也可能触发 Windows 安全提示。此前的旧发行包、旧 .NET 运行时回退副本、关联运行日志/回放文件和旧快捷方式已按维护者要求清理。

本机默认尝试加载原项目的 `tree` 数据；若数据在其他位置，请在界面中选择数据目录和对应的全景包。手动选择只在本次运行有效。人工校正点击保存时会写入所选数据目录。

### 源码开发模式

本机已安装依赖时，双击 `StartTreeExtract.cmd`，也可以在 PowerShell 中执行：

```powershell
cd .\desktop-js
npm.cmd start
```

在另一台 Windows x64 电脑上从源码构建或重新打包时，需要 Node.js 22.12 或更高版本、.NET 10 SDK 10.0.404 或更新的 10.0 版本，以及项目根目录的 `_deps/ort` 和 `models/tree_cls.onnx`。SDK 版本由根目录 `global.json` 约束，NuGet 依赖由 `packages.lock.json` 锁定。构建脚本先查找 `TREEEXTRACT_DOTNET` 指定的 `dotnet.exe`，再查找 `%LOCALAPPDATA%\TreeExtract\dotnet-sdk` 和系统 PATH。在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop-js\scripts\setup.ps1
```

安装脚本下载 Electron 运行时，并根据 Electron 包内的官方 SHA256 清单校验后解压；随后在 `desktop-js/runtime` 发布自包含的 .NET 10 后端。构建先写入临时发布目录并检查启动，再替换运行时，同时保留已有配置、数据和输出；如果开发版正在运行，应先关闭它。全景 ZIP 不随界面打包。

要重新打包单文件 EXE，可在 `desktop-js` 目录执行 `npm.cmd run package:win`。构建工具会检查下载的打包依赖；输出到 `release-net10` 目录，可能覆盖原 EXE。需要保留旧版本时，先备份并遵循[候选发布流程](../docs/DEVELOPMENT.md#制作与验收候选-exe)，不要直接覆盖。打包只包含后端运行库和模型，不会把 `runtime` 中的用户数据、人工标注、配置或日志放入 EXE。

## 操作说明

- 启动后按既有路径规则尝试加载数据。使用顶部按钮可选择另一套数据目录或单独指定全景 ZIP；两者必须来自同一批数据。手动选择只对当前进程生效。
- 顶部“合并采集数据”可选择 2～16 个原始采集目录。先点“分析是否可合并”，程序检查照片尺寸和命名、重名、位姿格式、相机参数以及投影和坐标校正参数；不能安全合并时会弹窗列出原因。通过后选择保存位置，程序新建结果目录，不覆盖原始数据，并保留 `merge-report.json` 说明。合并期间请勿修改源文件或关闭程序；失败时保留带 `_incomplete` 后缀的目录供检查。
- 全景包中的帧按时间顺序浏览；重复帧名、空照片或单帧展开后超过 128 MiB 会被拒绝，以避免选帧混乱及异常占用内存。
- 该功能目前只处理每个目录内的 `Camera4/Picture/PictureData/*.jpg`、`Camera4/Picture/Metashape.txt`、`Camera4/Picture/Camera4Param.txt`、根目录的 `imgPosList.txt`、`Block_1.xml` 和 `PointCloud.crd`。它合并全景及其位姿，**不会合并 LAS、PLY 或原始采集工程**，也不会根据 `tree_data.json` 猜测坐标偏移。缺少原始完整位姿的照片保留，但不能用于依赖完整位姿的定位。
- 如需合并完成后自动加载树列表，应在合并界面额外选择已经与影像坐标配准的树心数据目录（含 `tree_centers2.txt` 或 `tree_centers.txt`）；可选复制同目录的 `crown.csv`、`trunk.csv`，不复制旧人工校正。未选择树心时仍可生成影像包，但当前软件不能直接加载该结果。坐标参数一致或树心空间接近都不证明点云同源或精确配准；原始 OPK 的角度约定及红圈位置必须人工核查。
- 源码开发模式可通过 `desktop-js/runtime/TreeExtractor.ini` 配置默认数据路径。单文件 EXE 每次运行时会解压到临时目录，不会把该目录当作持久配置位置。
- 左侧按树 ID 搜索，列表只显示编号和高度，不显示或搜索原始文件中未经核实的树种。点击列表选择目标；手动切帧或“定位当前帧最近树”只固定当前树的相机；选择另一棵树时恢复自动选帧，重选当前树则保留固定帧。加载另一套数据时也会恢复自动选帧。
- 拖动全景预览旋转，滚轮缩放。点击“调整红圈”后，可在矫正照片或全景预览中点击、拖动到树干位置；松开时更新标注和切图。
- 人工校正仅在点击“保存校正”后写入当前数据目录的 `manual_marks.csv`。未保存时不能切换数据，关闭窗口也会询问保存。
- 如果校正文件在软件打开期间被其他程序修改，保存会拒绝覆盖并保留当前未保存状态；请先备份文件并处理冲突。每次成功替换已有校正文件时，程序会在同目录保留唯一命名的旧文件备份，不自动清理。校正文件格式错误或树号重复时，数据集不会切换，需先备份并修复。
- “定位与投影”可选择主帧策略。默认“优质近帧”结合距离、拍摄者经验方位、邻树视线、视场约束及画质，**不保证全局最近**。同一数据会话中，不同树已展示的主帧会被记录，优质近帧不会自动将其再次分配给另一棵树；没有独立可用帧时清空旧画面并提示。选择顺序可能影响后续候选，重新加载数据或重启后重新分配。
- “水平最近”逐帧比较相机到树干轴心（无轴心则树心）的水平距离，仍严格使用最近的有效帧；手动固定也保留用户所选帧。**这两种明确选择可能使用其他树已有的帧**，界面会提示共享及邻树遮挡风险，不会静默冒充不同视角。它们不保证树干可见、图片质量或人物安全。
- 附近树干在当前相机视线中接近时会提示可能遮挡或误认；这是依据树干坐标和角度的启发式提醒，不等于对实际树木身份或遮挡的检测。旧人工校正不会自动清除或保存，切换视角后请重新检查红圈。
- 除取景范围与经验方位的几何估计外，本地模型分别检查当前 4:3 照片和实际切图中的疑似人体、头部；检测阳性时对应画面默认隐藏，操作人员可明确选择查看当前图片。**头部检测不是头皮检测，模型可能误报或漏报，全景预览也未进行检测**；未检出、模型不可用或未命中经验区域都不能证明画面安全，仍需人工检查并必要时换帧。
- 保存 PNG 前必须人工核查并确认；确认与当时切图内容的 SHA-256 绑定，切图发生变化后必须重新确认。覆盖旧文件时会保留备份并提示路径。相关防护不保证模型漏检的头皮会被发现。
- 当前帧缺少完整位姿时，仍可浏览全景，但不会用旧帧的方向生成 4:3 照片或切图；相机与树干水平位置重合时也不会猜测方位。选择其他有完整位姿的帧或恢复自动选帧即可继续核查。
- 双帧模式自动选择辅助帧 B，最多尝试三张候选；当前帧也可以固定为 A。算法对多组候选做交会、邻树歧义、两帧共同高度和纹理检查；通过后将 A 的候选可见段裁到实际 4:3 画幅，取画面中点，并要求 B 覆盖该高度。通过阈值仍不能证明候选段就是正确树干。界面可展开逐次尝试的原因、轴心偏差和纹理指标；这些都是启发式指标，不是识别准确率。若回退，红圈高度为经验估计，应人工检查；已有人工校正优先，不会自动覆盖。
- 默认数据 120～170 号在本轮当前人工校正文件下有 50 条双帧回退、1 条人工优先，0 条双帧通过；较早快照的 51 条均回退。合成场景通过不能证明该批照片的实际准确率已提高。定位及人体/头部检查都需要进一步的独立影像标注验证。
- 缺少可靠树干轴心时，新自动结果使用树心方向，不再对所有树统一叠加历史 `2.7°` 修正；旧人工校正仍使用历史基点以保持兼容。人工校正存储为角度偏移，换帧后仍应检查。
- 对照表和 CSV / Excel 导出保留原有树心对照规则，**不随主帧策略切换，也不等于水平最近**。
- 手动修改目标方位、距离或仰角会关闭自动选帧；手动修改预览方位或俯仰会解除视角锁定。树、帧、切图参数或人工校正变化后，旧识别结果和热力图会清除，避免误认为属于新图像。
- 本地识别使用原有 18 类 ONNX 模型；热力图解释当前结果，不代表判定一定正确。对照表沿用原有 `PanoMath.Build` 口径，可导出 CSV / Excel。
- 展开“云端辅助与人工确认”，首次在本机填写并安全保存 DeepSeek API 密钥，以后无需重复输入。点击“开始识别”后，程序先显示**实际将上传的无树号干净切图**，经人工核查及默认取消的对话框确认后，并行启动本地和云端视觉识别，再由模型综合输出“分组 → 树种”建议。视觉和综合不是独立多数投票；最终仍由用户选择并确认保存。没有配置密钥或取消上传时仍可离线使用本地识别。
- 密钥通过 Windows 用户账户保护后，以密文存于当前用户应用数据目录，不写入源码、日志或打包产物；可在界面更换或删除本机密钥。相同 Windows 登录账户下的其他程序仍可能访问它，删除本机文件也不会撤销云端密钥。请勿将密钥粘贴到聊天、截图或仓库。
- 树种确认记录独立保存在当前 Windows 用户的应用数据目录，界面显示实际路径，不修改原始树木文件，也不会自动写入对照表。记录绑定数据集指纹、路径哈希、树 ID、序号、帧名和切图摘要；替换数据或移动目录后不会自动关联原确认。重新确认前会询问并保留旧记录备份；未保存的选择仅在本次运行按原图身份暂存。详细隐私、备份、类别映射和限制见[树种复核与全景交互](../docs/guides/树种复核与全景交互.md)。

## 代码结构

```text
desktop-js/
  src/main.js                 Electron 窗口、受限本地协议与进程生命周期
  src/preload.js              只向界面暴露明确的应用操作
  src/ipc-registrar.js        主进程 IPC 来源验证与注册
  src/tree-ipc.js             树木操作白名单、文件和导出对话框
  src/species-ipc.js          树种复核、密钥、预览与同意流程
  src/session-coordinator.js  会话互斥与预览失效管理
  src/backend.js              JSON 行协议客户端和进程生命周期
  src/species-cloud.js        可选的 DeepSeek 视觉和文字复核，限定请求目的地
  src/species-store.js        人工确认记录的独立、原子持久化
  src/species-catalog.json    用户提供的 7 组 119 项目录
  src/json-line-decoder.js    分块数据的 JSON 行解析与大小限制
  src/renderer/index.html     工作台结构
  src/renderer/styles.css     布局与视觉样式
  src/renderer/app.js         界面状态和用户交互
  src/renderer/tree-list-view.mjs   树列表展示及不必要重绘的消除
  src/renderer/table-view.mjs       对照表展示与选帧
  src/renderer/image-focus.mjs      放大模式和键盘焦点
  src/renderer/image-interactions.js  全景拖动与红圈坐标映射
  src/renderer/species-review.mjs   模型意见展示和人工确认
  src/renderer/pan-drag-queue.mjs   合并拖动事件并串行更新全景
  src/renderer/dual-frame-view.mjs   双帧状态展示模型与 DOM 更新
  src/renderer/photo-metadata-view.mjs  照片元数据与风险提示展示
  src/renderer/image-safety-gate.mjs   检出风险时隐藏图片与逐图确认
  bridge/DesktopBridgeProgram.cs          会话和控制台的生命周期
  bridge/DesktopProtocol.cs               JSON 行协议编解码
  bridge/BackendSession.DesktopBridge.cs  数据加载、状态、树木选择
  bridge/BackendSession.DesktopView.cs    图像、投影、红圈、识别
  bridge/BackendSession.DesktopTable.cs   对照表计算和导出
  scripts/                    环境准备与桥接构建
  tests/                      桥接和真实 Electron 界面回归测试
```

项目根目录的 `backend/TreeExtractor.Backend.csproj` 是 .NET 10 项目，`src/BackendSession*.cs` 保存分析会话与算法编排，`src/PanoramaRenderer.cs` 只生成预览位图，`src/DualFrame/` 保存双帧算法，`src/TreeTable.cs` 负责对照表计算和导出。`System.Drawing.Common` 用于 Windows 上的图像处理与标注，不是桌面 UI。构建沿用 `_deps/ort` 内的 ONNX Runtime；开发模式需要 `desktop-js/runtime` 中的桥接程序及运行库。

## 测试

```powershell
cd .\desktop-js
npm.cmd test
npm.cmd run test:architecture
npm.cmd run test:ui
npm.cmd run test:ui:layout
npm.cmd run test:ui:pan
npm.cmd run test:ui:species
npm.cmd run test:portable
npm.cmd run format:check
```

测试将运行时和小数据文件复制到系统临时目录，只读取原全景 ZIP；人工校正、回放日志、PNG 和表格导出均写入临时目录，不覆盖开发运行时中的数据。`tests/run_algorithm_tests.ps1`、`tests/run_dual_frame_tests.ps1`、`tests/run_dual_physical_tests.ps1` 和 `tests/QA-run-geometry.ps1` 使用 .NET 10 编译和运行。Electron 交互测试截图保存在 `test-artifacts`。双帧定位仍需人工复核。

从项目根目录可以使用 `scripts/verify.ps1` 作为统一验证入口，按需加入 `-Integration`、`-NearestAll` 和 `-PortableExe`。预检、真实数据路径、范围及未运行项目详见[开发与发布](../docs/DEVELOPMENT.md)。单独执行 `npm test` 时，缺少部分数据可能导致测试跳过；请阅读输出，不要把跳过视为通过。
