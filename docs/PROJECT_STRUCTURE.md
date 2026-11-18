# 项目目录说明

本目录说明当前项目的用途分类。软件、脚本和数据存在路径依赖，不应仅因目录名称相似就移动、覆盖或删除。

## 常用入口

| 位置 | 用途 |
| --- | --- |
| [`README.md`](../README.md) | 项目首页、启动与使用边界。 |
| [`desktop-js/release-net10/TreeExtract-frame-separation-20261117/TreeExtract.exe`](../desktop-js/release-net10/TreeExtract-frame-separation-20261117/TreeExtract.exe) | 当前保留的 Windows x64 目录版；复制或迁移时必须带上整个 `TreeExtract-frame-separation-20261117` 目录。 |
| [`docs/README.md`](README.md) | 文档分类索引。 |
| [`outputs/README.md`](../outputs/README.md) | 已有成果和数据索引；数据本身未因整理而移动。 |

## 源码、依赖与测试

| 目录 | 用途 |
| --- | --- |
| `desktop-js/src/`、`desktop-js/bridge/` | Electron 界面、进程通信及 .NET 桥接。 |
| `src/`、`src/DualFrame/` | 数据加载、算法、双帧定位、切图和识别。 |
| `backend/` | .NET 后端工程与依赖锁定文件。 |
| `models/` | 本地 ONNX 模型及许可文件，运行或构建所需。 |
| `_deps/`、`desktop-js/node_modules/` | 本地依赖；清理或迁移前先确认构建与运行要求。 |
| `tests/`、`desktop-js/tests/` | 测试、诊断和离线标注工具。 |
| `scripts/`、`desktop-js/scripts/` | 验证、构建、发布与部署脚本。 |
| `.github/`、`.editorconfig`、`.gitignore`、`global.json` | CI、编辑器约定、忽略规则和 SDK 版本配置。 |

## 文档与展示

| 目录 | 用途 |
| --- | --- |
| `docs/` | 核心架构、开发说明和总索引。 |
| `docs/guides/` | 功能与操作指南。 |
| `docs/research/` | 需求、算法设计、实验和排查记录。 |
| `docs/records/` | 历史验收、迁移和 QA 记录。 |
| `docs/presentations/` | 独立 HTML 展示页面及其附属文件。 |
| `.trae-html-share-packages/`、`.workbuddy/` | 既有工具生成的分享包或工作记录；保留原路径以免影响相关工具。 |

## 数据、成果与备份

- `outputs/` 保存合并数据、人工盲标资料、报告、图像、专利材料、历史验收结果和备份。目录中的内容性质不同，**不应整体视为缓存**。分类入口见[成果索引](../outputs/README.md)。
- `output/` 保存既有阶段性需求与文档处理成果；名称虽然与 `outputs/` 相近，但不是同一个目录，暂不合并。
- `desktop-js/runtime/` 是开发使用的后端运行时；`desktop-js/release-net10/` 当前保留 `TreeExtract-frame-separation-20261117/` 目录版及历史发布清单。此前旧程序包和旧 .NET 运行时回退副本已按维护者要求清理；源码回退快照位于 `outputs/frame-separation-verification-20261117/`，不含旧运行日志或回放文件。
- 整理前的文档快照保存在 `outputs/organization-backup-20261116-2828b5a8/`，其中的 `move-plan.json` 记录了本次移动的原路径与新路径。

人工校正通常位于相应数据目录的 `manual_marks.csv`。真实照片、标注、日志、截图及现场位置信息可能敏感；移动、替换、分享或清理之前应先确认归属并备份。当前工作目录未初始化 Git，`.gitignore` 不能代替备份。
