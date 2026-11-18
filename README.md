# TreeExtract

TreeExtract 是面向 Windows 的桌面应用：加载树木位置、相机位姿和全景照片，辅助查看树干、人工校正红圈、导出切图与对照表，并运行本地树种模型。用户也可自愿同意上传当前切图，使用云端视觉与文字复核辅助人工确认。界面采用 JavaScript / Electron；图像和定位由独立的、无界面的 C# / .NET 10 进程处理。

AI 和人工维护本项目时，从项目根目录开始，先读[项目开发规则](AGENTS.md)和[系统设计](docs/ARCHITECTURE.md)。

## 一键启动

本机当前保留的 Windows x64 目录版为 `desktop-js/release-net10/TreeExtract-frame-separation-20261117/TreeExtract.exe`。这是免安装版本，运行时和模型位于同一目录，启动无需重新解压；移动时须连同整个 `TreeExtract-frame-separation-20261117` 文件夹复制。旧发行包、旧 .NET 运行时回退副本及原快捷方式已按维护者要求清理；改动前源码快照另存于 `outputs/frame-separation-verification-20261117/`，不包含被清理的旧运行日志或回放文件。EXE 未进行代码签名，Windows 可能显示安全提示。

本机程序会按既有规则尝试查找 `E:\树木识别\tree`。换电脑后请在界面选择数据目录和同批次的全景 ZIP，人工保存的校正写入数据目录的 `manual_marks.csv`。在移动、替换或清理数据前，请先备份该文件和其他原始数据。详细操作与配置见 [桌面使用说明](desktop-js/README.md)。

## 使用边界——必须人工复核

- 默认“优质近帧”综合距离、方位、邻树视线、视场和画质，并在同一数据会话内避免不同树复用自动主帧；可用帧不足时明确提示，不用其他树的画面冒充。它**不保证全局最近或树木身份准确**。“水平最近”仍按实际水平距离选帧，可能与其他树同帧并提示；手动选帧也允许同帧。
- 双帧会尝试核对同一候选树干，但成功状态只是通过当前启发式检查，**不是识别准确率或目标正确性的保证**。失败会显示单帧经验回退；人工校正优先。
- 默认数据 120～170 号在旧人工校正快照中为 **0 / 51 双帧通过、51 / 51 回退**；本轮当前校正文件下为 **0 条双帧通过、50 条回退、1 条人工优先**。合成测试通过不代表现场准确率已经提升；需要独立人工真值后再评价。
- 本地模型分别检查 4:3 照片和切图中疑似人体、头部；检出时界面默认隐藏对应画面，可由操作人员选择查看。**头部检测不等于头皮检测，模型会误报和漏报，全景预览未检测，不能保证无人物或头皮**。保存切图前必须人工核查；具体边界见[人体与头部检测](docs/guides/人体与头部检测-20261113.md)。
- 云端为可选功能：仅在人工核查并逐次确认后才上传当前干净切图；可能产生费用，图像本身仍可能包含人、地点文字等隐私。视觉结果和文字综合均可能出错，综合意见不是独立投票；最终树种必须由人选择并确认。使用和保存范围见[树种复核与全景交互](docs/guides/树种复核与全景交互.md)。

## 现场准确率如何继续验收

此前准备的 `outputs/QA-D1-blind-20261113/` 影像和标注模板已于 2026-11-17 按维护者要求删除；后续若要继续验收，应从原始数据重新准备隔离副本和空模板。可用[离线标注页面](tests/annotation/index.html)打开新模板、选择 `clean` 文件夹，为有把握的树干标注可见部分中点；看不清或不能确认目标时应保留“未知”。标注不上传网络，照片和结果仍是敏感现场数据，请自行保护。

这一步需要人工独立判断，程序不能自行制造真值。标注、双帧候选复核和报告生成的完整流程见[真实影像独立标注与验收](docs/guides/真实影像独立标注与验收.md)；空模板会明确显示“未评估”，不会被记为准确。

## 代码与数据位置

```text
desktop-js/src/              Electron 主进程、预加载接口、界面及桥接客户端
desktop-js/bridge/           .NET JSON 行协议和桌面会话适配
src/                         数据加载、定位、投影、切图和识别
src/DualFrame/               双帧观测、候选、几何、纹理与回放
backend/                     .NET 10 自包含后端项目与依赖锁文件
tests/                       几何、算法、真实数据与架构测试
models/                      本地 ONNX 模型
docs/                        文档索引、系统设计和开发说明
docs/guides/                 功能和操作指南
docs/research/               需求、研究设计和排查记录
docs/records/                历史验收和测试记录
docs/presentations/          展示网页
outputs/                     合并数据、标注、报告、图片和备份
output/                      既有阶段性需求和文档处理成果
scripts/verify.ps1           分层验证入口
```

`desktop-js/runtime*`、`release*`、`node_modules`、`test-artifacts`、`output` 和 `outputs` 是构建产物或本机数据，并非随意可删的源码；其中可能包含旧版本、配置、人工标注或输出。`.gitignore` 只防止误加入版本库，**不会备份或保护文件**。本项目已使用 Git 管理。提交前仍应检查暂存内容，避免纳入用户数据、密钥、模型和其他敏感文件；`.gitignore` 只用于防止误加入，不构成备份或安全保护。

详细分类见[项目目录说明](docs/PROJECT_STRUCTURE.md)和[成果与数据索引](outputs/README.md)。

## 开发与验证

Windows PowerShell 5.1 可用；源码构建需要 Node.js 22.12+、.NET 10 SDK 10.0.404+、`_deps/ort` 和 `models/` 中的树种、人像模型及其许可文件。先在项目根目录运行一次 `desktop-js/scripts/setup.ps1` 准备依赖，或按 [开发与发布](docs/DEVELOPMENT.md) 检查已有环境。验证脚本不自动重建后端或 EXE，因此源码更改后先按文档构建。

Git 仓库按维护者要求不跟踪 `_deps/` 和 `models/*.onnx`。从源码构建前，请通过获准的内部渠道准备这些依赖和模型；不要将其或现场数据提交到仓库。

在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1 -Integration -NearestAll
```

第一条是基础验证；第二条还需指定位置的三套真实数据、Electron、Playwright 和本地 Chrome 或 Edge，运行集成、UI 及最近帧穷举对照。打包 EXE 的验证需单独指定 `-PortableExe`；严格要求文件符号链接测试使用 `-RequireSymlink`，权限不足时会失败。范围、跳过项、输出和数据隔离见 [开发与发布](docs/DEVELOPMENT.md)，架构见 [系统设计](docs/ARCHITECTURE.md)，全部文档见 [文档索引](docs/README.md)。
