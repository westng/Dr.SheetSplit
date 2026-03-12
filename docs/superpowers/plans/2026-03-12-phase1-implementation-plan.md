# Excel Splitter Desktop Phase 1 实施计划

- 日期：2026-03-12
- 关联规格：`docs/superpowers/specs/2026-03-12-excel-splitter-desktop-design.md`
- 目标：交付可演示的桌面 UI 骨架（不含真实 Excel 拆分）

## 1. 交付物

- Tauri + Vue 3 + TypeScript 工程可运行
- 双栏主界面（左配置、右工作区）
- 本地 Excel 文件选择（点击+拖拽）
- 模拟执行流程（进度 + 模拟结果）
- 基础错误处理与状态机
- 最小可用测试集（单测 + 组件测试 + 冒烟脚本）

## 2. 工作分解（WBS）

## 2.1 工程初始化

- 新建 `Tauri + Vue + TS` 工程
- 配置基础目录结构（components/services/stores/types/pages）
- 接入状态管理（Pinia）与测试框架（Vitest + Vue Test Utils）

验收：

- `npm run dev` 可启动前端
- `npm run tauri dev` 可启动桌面壳

## 2.2 主布局与页面骨架

- `MainPage.vue` 完成左右两栏布局
- 左栏创建 `ConfigPanel` 占位模块
- 右栏创建 `WorkspacePanel` 占位模块

验收：

- 启动后可稳定展示双栏布局（Windows/macOS）

## 2.3 文件导入模块

- 实现文件点击选择（Tauri dialog）
- 实现拖拽导入
- 文件类型校验（`.xlsx/.xls`）
- 文件元数据展示（名称、大小、路径）

验收：

- 合法文件进入 `ready`
- 非法文件触发错误提示

## 2.4 状态机与任务流转

- `stores/task.ts` 定义状态：`idle/ready/running/success/error`
- 实现状态迁移守卫（执行中禁止重复触发）
- 重新选文件自动重置结果

验收：

- 状态迁移符合 spec，且可在 UI 观察到

## 2.5 模拟执行引擎

- `services/mock-engine.ts` 提供统一接口：
  - `startTask(payload)`
  - `cancelTask(taskId)`
  - `onProgress(callback)`
- 模拟执行时长与进度更新
- 输出模拟分表结果（>=2 条）

验收：

- 点击“开始处理”后进度递增并最终返回结果列表

## 2.6 错误处理与提示

- 文件读取失败提示
- 模拟执行失败分支（可注入失败开关）
- `error` 态重试按钮

验收：

- 任意异常均可回到可操作状态（`ready` 或重试）

## 2.7 测试与验收

- 单元测试：
  - 配置校验
  - 状态机迁移
  - 模拟引擎输出结构
- 组件测试：
  - 文件导入与按钮可用性
  - 运行态 UI 变化
- 冒烟清单（手工）：
  - 正常路径
  - 非法文件
  - 执行中重复点击

验收：

- 关键测试通过，冒烟 3 条全部通过

## 3. 建议开发顺序（5 天节奏）

1. Day 1：工程初始化 + 主布局
2. Day 2：文件导入 + 类型校验
3. Day 3：状态机 + 模拟引擎
4. Day 4：错误处理 + UI 打磨
5. Day 5：测试补齐 + 验收修复

## 4. 风险与应对

- Tauri 文件能力在双平台细节差异
  - 应对：优先使用官方 API，避免平台特化路径逻辑
- 后续 Python 接入协议变化
  - 应对：严格通过 `engine` 接口层隔离调用方
- 拖拽在不同系统行为不一致
  - 应对：保留“点击选择”作为稳定兜底路径

## 5. 启动清单（你可以直接执行）

1. 初始化仓库并提交规格/计划文档
2. 创建 Tauri + Vue + TS 工程骨架
3. 按 WBS 2.2 开始实现页面布局

