# 开发、验证和发布

## 环境与依赖

- Windows x64；示例兼容 Windows PowerShell 5.1。使用终端前确认当前目录，不要依赖 Bash 的 `&&`、`export` 或 heredoc 语法。
- Node.js 22.12.0 及以上；版本与直接开发依赖见 `desktop-js/package.json`，依赖树记录在 `desktop-js/package-lock.json`。
- .NET 10 SDK 10.0.404 或 `global.json` 允许的更新版本。`desktop-js/scripts/find-dotnet.ps1` 依次查找 `TREEEXTRACT_DOTNET`、`%LOCALAPPDATA%\TreeExtract\dotnet-sdk\dotnet.exe` 和 PATH；后端依赖记录在 `backend/packages.lock.json`，测试依赖记录在 `tests/packages.lock.json`。
- 项目需要 `_deps/ort` 下的 ONNX Runtime、`models/tree_cls.onnx`、`models/person_head.onnx` 和 `models/PERSON_HEAD_LICENSE.txt`。后端构建及检测器会校验人像模型哈希。运行已打包 EXE 不要求用户安装 Node.js 或 .NET SDK；不支持的系统或缺失的 Visual C++ 运行库仍可能导致启动失败。
- Git 仓库按维护者要求排除 `_deps/` 与 `models/*.onnx`。源码构建前应通过获准的内部渠道准备相应依赖和模型；不要将模型权重、现场数据或用户配置提交到 GitHub。

## GitHub 仓库与同步

正式源码仓库为公开的 [lifiqin/TreeExtract](https://github.com/lifiqin/TreeExtract)，默认分支为 `main`。克隆后先确认工作区状态，再快进同步远端：

```powershell
git clone https://github.com/lifiqin/TreeExtract.git
Set-Location .\TreeExtract
git status --short --branch
git pull --ff-only origin main
```

完成改动后，按本文件的验证要求运行对应检查，再逐个暂存本次变更文件并复核内容；不要用 `git add .` 或 `git add -A` 把本机数据一并加入：

```powershell
git status --short
git diff --check
git add README.md docs\DEVELOPMENT.md
git diff --cached --check
git diff --cached --stat
git commit -m "docs: update Git workflow"
git push origin main
```

示例中的 `git add` 路径和提交说明应按实际改动替换。推送前确认暂存区只有本次任务相关文件，且 GitHub Actions 的结果已检查；不要强制推送或改写公共历史。当前公开仓库中的提交可能被他人克隆或派生；即使之后删除文件，旧提交中的内容仍可能留存。`.gitignore` 不能替代审查，也不会自动从历史中移除已跟踪文件。用 `git check-ignore -v "path\to\file"` 核对忽略规则，但不能因此提交真实数据、影像/点云、人工标注、密钥、用户配置、日志或未经批准的模型。

`.github/workflows/windows-ci.yml` 配置了 GitHub Actions Windows CI，响应 `push`、`pull_request` 和手动触发；它运行锁文件依赖安装与审计、隔离后端构建及基础验证。CI 不覆盖私有真实数据、Electron UI、便携 EXE 或可信代码签名；仓库存在工作流文件不代表检查已通过。每次推送后请在 [GitHub Actions](https://github.com/lifiqin/TreeExtract/actions) 查看对应运行结果。

首次从源码准备环境，可在项目根目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop-js\scripts\setup.ps1
```

脚本会联网安装 npm 依赖、按 Electron 包提供的 SHA-256 清单校验下载的 Electron 二进制，并构建后端。它调用 `npm install`；审核依赖变化时应检查锁文件差异，不要假设每次联网安装必然得到完全相同结果。仓库提供 CI 配置和单文件签名脚本，但远端 CI 和可信签名尚未启用。

## 开发模式与后端重建

在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop-js\scripts\build-bridge.ps1 -KeepBackup
cd .\desktop-js
npm.cmd start
```

`build-bridge.ps1` 先发布到唯一暂存目录，校验必要文件、自包含配置和 JSON 协议启动，再替换 `desktop-js/runtime`；它保留旧运行时中不属于新发布文件的内容。运行开发版之前必须关闭正在使用该运行时的程序。`-KeepBackup` 会保留先前运行时及失败时的暂存目录，并输出位置，适合需要保留回滚材料的场景；备份可能包含用户数据。默认不加该参数时，脚本会尝试清理自己创建的备份和暂存目录。

**注意：改完 C# 源码后只运行测试，不会自动更新 `desktop-js/runtime`。** 先重建运行时，再测试实际 Electron 进程或打包；相反，重建运行时也不会更新已生成的 EXE。禁止把源码测试通过误写为旧制品已经更新。

## 质量验证入口

在项目根目录执行，任何步骤失败会以非零状态停止。脚本预检必要工具和指定数据，结束时列明没有执行的范围；它不会自动构建或打包。

```powershell
# 基础：JS 单元测试、格式、无 WinForms 检查、四组 .NET 算法测试
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1

# 在基础验证之外，检查三套数据上的完整集成、真实 Electron UI 和最近帧穷举
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1 -Integration -NearestAll

# 先将当前目录版复制到新的临时目录，再对隔离副本启动冒烟测试
$smokeRoot = Join-Path $env:TEMP 'treeextract-frame-separation-smoke'
if (Test-Path -LiteralPath $smokeRoot) { throw 'Choose a new temporary smoke-test directory.' }
Copy-Item -LiteralPath .\desktop-js\release-net10\TreeExtract-frame-separation-20261117 -Destination $smokeRoot -Recurse
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1 -PortableExe (Join-Path $smokeRoot 'TreeExtract.exe')

# 在具有创建文件符号链接权限的 Windows 测试环境，要求该项不能跳过
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1 -RequireSymlink
```

选项可组合。基础验证包含采集合并、数据读取顺序和人工校正持久化回归。`-Integration` 追加其余 JS/桥接测试、真实 Electron UI、模拟布局、合成照片的合并界面、真实全景拖动和离线标注浏览器测试，不再重复运行基础桌面测试；`-NearestAll` 独立逐棵计算并对比三套数据的水平最近相机；`-PortableExe` 参数可接收单文件 EXE，或经过隔离校验的目录版副本。真实目录版测试必须先复制到临时目录，不能直接启动发布文件夹中的 EXE。它们不是算法的人工真值准确率测试，也不等于覆盖所有输入。

基础质量门自动发现 `desktop-js/tests/` 下的 `*.test.js`；需要真实数据或完整构建的例外由 `scripts/verify.ps1` 中的 `integrationOnly` 清单单独维护。`npm.cmd test` 仍可独立运行所有桌面测试。

帧去重及邻树歧义用合成数据覆盖单帧不足、人工/最近模式共享和数据重载；`-Integration` 额外检查默认真实数据 106 / 107 的双向切换及真实 Electron 提示。`-NearestAll` 继续检验严格最近算法，不受优质模式的主帧预留规则改变。所有这类检查都不是人工树号真值。

[项目开发规则](../AGENTS.md)中的窗口隔离、IPC 来源校验和本地页面路径边界由 `main-architecture.test.js` 检查。该用例执行真实主进程装配代码，使用模拟 Electron 和桥接进程，不接触用户数据；实际运行行为仍由 Electron 集成和打包烟雾测试覆盖。

质量门对常规检查临时关闭实验双帧开关，并在物理测试中启动独立的默认/实验进程；结束时恢复调用方环境。人体测试可能因权限跳过文件符号链接创建；默认模式会明确列出 `PASS WITH SKIPS`，`-RequireSymlink` 则要求该项执行，权限不足必须失败。真实场景标注仍需另按[独立标注与验收](guides/真实影像独立标注与验收.md)执行。

可设置 `TREEEXTRACT_TEST_BRIDGE` 指向隔离候选 `TreeExtractorBridge.exe`，让质量门、真实桥接和 Electron UI 测试使用该候选，而不先覆盖开发运行时。调用前后应记录文件哈希；该设置不自动改变已打包 EXE。

完整数据预检使用项目父目录的 `tree`、`dataset_runtime/data` 和 `dataset_runtime_full/data`。每套需有 `Camera4.zip`、`tree_centers2.txt`、`Metashape.txt`、`imgPosList.txt`、`crown.csv`、`trunk.csv`、`manual_marks.csv`。`-PortableExe` 至少需要 `tree`；集成/UI 还需 Electron、Playwright 和本地 Chrome 或 Edge；最近帧穷举需要系统 `tar.exe`。单独运行 `npm test` 时，部分数据或后端缺失的测试会报告 `skip`，不能将跳过当作完整通过。

基础 .NET 测试会构建到 `tests/bin`、`tests/obj`；构建也会使用 `backend/bin`、`backend/obj`。真实数据测试在系统临时目录复制模型、运行时及元数据，只读取源 ZIP，人工标记和测试导出写入副本；UI 截图会写入 `desktop-js/test-artifacts`。测试产生的临时目录和日志可能含真实数据、路径或截图，按组织的数据安全要求处理。不要把测试清理脚本指向用户数据目录。

### 默认数据 120～170 回放

以下在项目根目录运行，会使用当前 `desktop-js/runtime` 和父目录 `tree`，复制小数据文件、只读原 ZIP；`TREEEXTRACT_QA_SKIP_FIXED` 只跳过固定帧状态对照，不是关闭双帧：

```powershell
$env:TREEEXTRACT_QA_SKIP_FIXED = '1'
node .\tests\qa-selection-default.js
Remove-Item Env:TREEEXTRACT_QA_SKIP_FIXED
```

程序输出的临时目录包含报告和选定图片。回放可用于比较重构前后的相机、角度、状态和回退原因，但没有人工真值时不能据此声称定位正确；当前已知结果见 [双帧候选互证与点云排查](research/双帧候选互证与点云排查-20261112.md)。

## 制作与验收候选 EXE

1. 确认用户数据和旧产物已备份，关闭正在使用相关文件的进程，运行后端重建和质量验证。
2. 在 `desktop-js` 下选用一个**不存在的新目录**构建候选，避免直接覆盖稳定 EXE：

   ```powershell
   .\node_modules\.bin\electron-builder.cmd --win portable --x64 --publish never --config.directories.output=release-candidate
   ```

3. 返回项目根目录，对候选使用上面的 `-PortableExe` 烟雾测试；记录文件 SHA-256、测试日期、数据范围、跳过项及已知限制。该测试会启动真实的打包程序，包括一次默认数据路径检查和一次隔离数据检查。
4. 通过验收后，由维护人员先备份原 EXE、确认原文件未被占用，再将候选部署到稳定位置并再次检查哈希与启动。不要将整个未检查的 `runtime`、测试图片、人工标注或原数据打包分发。

候选构建目录应视为只读制品：**不要直接启动其中的 `win-unpacked/TreeExtract.exe`，尤其不能在打包进行时启动；也不要把用户的目录版直接用于自动化烟雾测试**。应用运行时可能在其 `resources/runtime` 生成或改写日志和输出。需要测试目录版时，先将已完成的干净候选复制到系统临时目录，再用烟雾测试启动该副本并检查其中的 ASAR、后端及模型。测试会拒绝非临时目录、含既有日志/输出/配置的目录和名为 `win-unpacked` 的目录。若候选目录已运行过，重新从源码构建新的干净候选，不直接删除或覆盖不明文件。便携包烟雾测试使用独立的临时解压目录。

当前保留的目录版位于 `release-net10/TreeExtract-frame-separation-20261117`。目录版使用同一次候选构建得到的 `win-unpacked` 内容，验收其 `TreeExtract.exe`、`resources/app.asar`、后端 DLL 与模型；避免单文件每次启动重新解压，但须保留整个目录，不能只复制 EXE。旧版 `TreeExtract-fast`、相关旧打包目录及旧 .NET 运行时回退副本已按维护者要求清理。仓库内的 `deploy-fast.ps1` 仍面向旧 `TreeExtract-fast` 路径，且要求该目录预先存在；在为新目录设计并验证新的升级/回退流程前，不要将它用于当前发布目录。不要把用户应用数据或密钥打入发布目录。

若需要更新已有目录版，可在 `desktop-js` 目录使用 `scripts/deploy-fast.ps1`，明确指定位于工作区内、已经验证的候选 `win-unpacked` 目录和唯一 `-Tag`。脚本拒绝目录链接或正在运行的目录版，先写入新目录、保留旧目录中额外的用户文件、逐文件核对候选哈希，再保留完整旧目录备份并切换；失败不自动删除目录。发布前仍需人工确认候选、回滚及数据归属。

可用[本地发布清单](guides/本地发布清单.md)记录当前源码、依赖、模型和已验收 EXE 的哈希。清单只是读取时的内容快照，不证明制品由所列源码构建，也不是签名或软件物料清单。

`npm.cmd run package:win` 是便捷脚本：它先重建运行时，再向 `release-net10` 打包，可能替换现有输出，且默认会尝试清理脚本自己的备份。需要保留旧版本或用户数据时，不要直接使用它代替上述候选发布流程。

## 修改界面、IPC 与协议

1. 界面展示逻辑放在 `renderer` 的对应视图模块，`app.js` 负责状态和交互编排。更新 `state.trees` 时替换数组；修改筛选或选中行为时运行 `tests/tree-list-view.test.js` 和真实 Electron 布局测试。
2. 新增 IPC 时，由 `ipc-registrar.js` 注册并统一校验来源；按职责放入 `tree-ipc.js` 或 `species-ipc.js`，只向 `preload.js` 暴露确需的操作。考虑会话互斥、预览失效和人工确认，不应让页面直接调用内部验收快照。
3. 改动桥接方法时，同步检查 `TREE_BRIDGE_METHODS`、`BackendSession.DesktopBridge.cs` 分发和参数格式；运行 `tests/ipc-coordination.test.js` 与真实桥接集成测试。文件名和函数名对应职责，而不意味着 IPC 对恶意本机程序构成安全隔离。
4. JSON 行编解码在 `DesktopProtocol.cs`，控制台和进程生命周期在 `DesktopBridgeProgram.cs`。修改后运行 `tests/run-modern-tests.ps1 -Mode protocol`，再重建后端并测试真实进程；单测不替代完整 IPC 和 EXE 测试。
5. 发布前分别测试目录版与单文件版，并在隔离用户数据下验证密钥与保存记录。未改动数据或算法，不意味着照片定位、识别或人体检测准确性已得到独立验证。

## 安全与维护现状

- UI 的本地协议与 IPC 做了边界约束，但这不是正式渗透测试，也不是全面安全认证。EXE 当前未签名；没有现成的自动更新、远端 CI 发布或集中监控。
- 2026-11-13 的 npm 官方审计最初有 6 个中等级告警，关联 [`minimatch` 上游安全公告](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)；经隔离评估，将构建依赖中 `minimatch@9` / `@10` 显式覆盖到 `11.0.8` 后，官方 registry 审计结果为 0。此覆盖跨主版本，已测试当前 Windows 打包白名单和便携包，不代表其他未使用平台的兼容性；后续应跟进上游并重新审计。默认 npm 镜像审计接口返回 404。NuGet 漏洞查询当日无结果，但它不覆盖手工引用的 ONNX Runtime 二进制或模型。
- `.github/workflows/windows-ci.yml` 已接入 GitHub Actions，并在推送、拉取请求和手动触发时运行；工作内容及未覆盖范围见[GitHub 仓库与同步](#github-仓库与同步)。是否通过以 [GitHub Actions 运行记录](https://github.com/lifiqin/TreeExtract/actions) 为准；配置工作流不等于通过门禁。私有现场数据、UI/EXE 及签名不在此基础作业中。模型和 `_deps/ort` 仍须通过组织批准的安全方式提供给 CI。
- 人体模型来源与已知训练数据/权重权利不确定性见[人体与头部检测](guides/人体与头部检测-20261113.md)。尚未完成完整商用许可审查，也未凭模型的头部结果推断头皮结果。
- 不将现场照片、位姿、真实路径、人工标注、临时日志或敏感截图上传到公开仓库。发布新包前记录 SHA-256，并在安全环境完成独立数据与人工真值验证。

## 单制品代码签名接入（待证书）

`desktop-js/scripts/sign-artifact.ps1` 只处理明确传入的单个 `.exe` 或 `.dll`：要求预期制品 SHA-256、Windows 证书库中的代码签名证书指纹、HTTPS RFC 3161 时间戳服务和可信 Microsoft `signtool.exe`。它在同目录暂存签名，核对签发者、信任状态与时间戳后才原子替换，并保留原件备份。应在隔离的不可变候选目录中使用，禁止并发构建/签名；不要把证书、私钥或密码存入仓库。

当前没有证书，脚本只验证了错误参数、未信任工具等拒绝路径；**成功签名、可信时间戳以及完整包内外文件的签名链均未实测**。以后获得证书后，须按组织发布策略对自己的内嵌后端、Electron 可执行程序和外层便携包分别规划签名、验签和发布，不能只签外层就宣称整个包已完成签名审核。
