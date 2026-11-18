# 文档索引

文档按当前维护说明、功能指南、研究设计、历史验收和展示页面分类。历史记录保留当时的结论，不代表所有设想已经实现；与当前代码或较新的实测结果冲突时，以后者为准。

## 项目与开发

- [项目首页](../README.md)：启动入口、使用边界与开发概览。
- [项目目录说明](PROJECT_STRUCTURE.md)：项目文件、运行程序和成果的分类与保护规则。
- [桌面应用使用说明](../desktop-js/README.md)：操作、配置和界面行为。
- [系统设计](ARCHITECTURE.md)：模块职责、进程通信和数据生命周期。
- [开发与发布](DEVELOPMENT.md)：依赖、测试、打包与回滚。
- [贡献约定](../CONTRIBUTING.md)：变更、评审和数据保护规则。
- [成果与数据索引](../outputs/README.md)：已保留的数据、报告、图像和备份。

## 功能指南：`guides/`

- [本地识别接入说明](guides/本地识别接入说明.md)
- [人体与头部检测](guides/人体与头部检测-20261113.md)
- [树种复核与全景交互](guides/树种复核与全景交互.md)
- [双帧图证接口](guides/双帧图证接口-20261113.md)
- [真实影像独立标注与验收](guides/真实影像独立标注与验收.md)
- [本地发布清单](guides/本地发布清单.md)

## 研究与设计：`research/`

- [双帧交会定位需求](research/PRD-双帧交会定位.md)
- [双帧交会定位设计](research/ARCH-双帧交会定位.md)
- [双帧交会定位 R3 设计](research/ARCH-双帧交会定位-R3.md)
- [双帧候选互证与点云排查](research/双帧候选互证与点云排查-20261112.md)
- [双帧边缘连续候选实验](research/双帧边缘连续候选实验-20261113.md)
- [选帧修复与回归](research/选帧修复与回归-20261112.md)
- [定位与投影改进](research/定位与投影改进-20261111.md)

## 验收与历史记录：`records/`

- [2026-11-17 主帧避让与邻树歧义](records/主帧避让与邻树歧义-20261117.md)
- [2026-11-16 行为保持型重构验收](records/行为保持型重构验收-20261116.md)
- [.NET 10 迁移与 QA](records/.NET10迁移与QA-20261112.md)
- [工程化验收](records/工程化验收-20261113.md)
- [架构与可读性优化验收](records/架构优化验收-20261113.md)
- [联合识别与资源优化验收](records/联合识别与资源优化验收-20261113.md)
- [测试版验收](records/测试版验收-20261113.md)
- [树种复核与全景交互验收](records/树种复核与全景交互验收-20261113.md)
- [左侧原始树种移除验收](records/左侧原始树种移除-20261113.md)
- [无窗口后端重构](records/无窗口后端重构-20261112.md)
- [双帧交会回归](records/QA-双帧交会回归.md)
- [双帧交会回归第 2 轮](records/QA-双帧交会回归-第2轮.md)
- [最近相机与双帧 QA](records/QA-最近相机与双帧-20261112.md)

## 展示页面：`presentations/`

- [选帧原理说明](presentations/frame-selection-explained/frame-selection-explained.html)
- [TreeExtract 工作总结](presentations/treeextract-work-summary/treeextract-work-summary.html)

部分历史报告可能提到已移除的 WinForms 界面、旧阈值、旧备份或过时的部署方式。不要仅凭历史设计文档判断当前功能已达预期。
