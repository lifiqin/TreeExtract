# Python 投影算法试点

这是与正式软件隔离的实验，Python 文件没有被 Electron、IPC 或 .NET 后端调用。正式程序仍使用 [`src/Proj.cs`](../../src/Proj.cs)；无需安装 Python 即可继续运行现有程序。本目录只移植纯数学部分，不读取现场数据、影像、模型、人工校正或密钥。

## 范围与兼容性

- 移植了半幅尺度、水平视场角、世界方向到照片像素、照片径向逆投影以及全景预览针孔逆投影。
- 公式、48 次二分、视线不可投影时回到画面中心、俯仰限制在 ±89° 的行为以当前 C# 实现为准。调用方需要区分照片的径向投影和全景预览的针孔投影；不要把回到画面中心误认为目标可见。
- `d` 显式传参，默认 `1.0`，可指定旧值 `0.5`。它替代 C# 的进程级可变 `NaturalD`，并不意味着可以在正式软件运行时切换实现。
- 当前只对有限数值、有效且非零的投影尺度、非奇异的参数做过验证；测试重点是 `d=0.5/1.0`、视场角 40°～120°、常见画幅比例和部分边界。Python 对零除、非有限值和极端数值的异常/浮点行为可能与 C# 不同，尚不能直接替换或宣称所有输入逐位一致。
- **不包含**选帧、树木身份/邻树冲突、双帧交会、图片渲染、文件读写、识别模型或 UI。相同计算结果也不证明现场树木身份、定位准确率或识别准确率。

## 验证

需要 Windows、Python 3.10+ 和项目要求的 .NET 10 SDK。Python 试点仅使用标准库，无需安装第三方 Python 包。在项目根目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\python_projection\run-parity.ps1
```

如果 Python 不在 PATH，显式传入解释器绝对路径：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\python_projection\run-parity.ps1 -Python "C:\Python312\python.exe"
```

脚本编译测试专用 C# 程序，直接链接真实 `src/Proj.cs` 和 `src/Geometry.cs`，对同一组合成输入逐项对照 Python；它还检查照片投影往返、接缝、边界、两种 `d` 和俯仰钳制。对照采用绝对误差 `5e-10` 或相对误差 `5e-11`，不是逐位相同的保证。oracle 的 `bin/`、`obj/` 被本地忽略；脚本不会修改正式后端或调用真实数据。此试点测试不属于项目基础质量门，需要单独运行；GitHub Actions 中另设有独立的 `python-projection-parity` 作业，实际状态以运行记录为准。

## 直观对照与微基准

使用不存在的输出目录运行下列命令；有已知 Python 绝对路径时可额外传 `-Python`。脚本仅生成合成输入，不会覆盖已有目录：

```powershell
$out = Join-Path (Get-Location) 'outputs\projection-comparison-example'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\python_projection\run-comparison.ps1 -OutputDirectory $out
```

结果包括 `summary.json`，记录数值对照、逐次计时和环境。若 Python 环境提供 Pillow 且 Windows 安装了微软雅黑，还会生成 `projection-comparison.png`。Pillow 只用于这张可选示意图，不是试点算法或一致性测试的依赖；缺少时 `visual_created` 为 `false`。示意图是合成方向点，不是现场照片或检测效果。[一次本机测试记录](BENCHMARK.md)解释了测量方法和局限；不要把微基准的倍率当成整个软件的加速比。

## 后续迁移与回退

Python 可用于算法实验，但全面替换 C# 还须逐模块核对：JSON Lines 协议和错误语义、会话与并发、图像处理、ONNX 及其模型、帧预留与人工校正、保存和上传确认、性能、Windows 分发及许可证。必须补充真实进程/界面、异常与数据保护测试，并在有独立人工真值时核对现场效果；不能凭本次数学对照或合成样本宣布整体兼容或准确率提升。

建议先继续隔离移植和差异测试，再设计可选后端适配与灰度开关，在独立候选和真实 EXE 上验证；切换正式入口前保留原 C# 运行时、数据和配置以及明确回退方法。当前没有发生运行时切换；要停止实验可保留原程序并切回 `main`，不需要修改数据或覆盖任何 EXE。
