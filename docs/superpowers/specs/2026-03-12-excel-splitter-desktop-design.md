# Excel Splitter Desktop 设计文档（Phase 1）

- 日期：2026-03-12
- 项目：Dr.SheetSplit
- 目标平台：Windows + macOS
- 当前阶段：Phase 1（基础配置与流程骨架）

## 1. 背景与目标

构建一个桌面应用，用于从本地导入 Excel，按规则拆分为多个分表并导出。  
本阶段不实现真实拆分业务，仅交付可演示的 UI 骨架与模拟流程，为后续接入 Python 处理引擎做准备。

## 2. 范围定义

### In Scope（Phase 1）

- 左侧配置区与右侧工作区 UI 骨架
- 本地文件选择（Excel）
- “开始处理”流程（模拟执行 + 伪进度 + 模拟结果）
- 基础状态机（idle/ready/running/success/error）
- 基础错误提示（文件类型、读取失败、模拟失败）

### Out of Scope（Phase 1）

- 真实 Excel 解析与拆分逻辑
- 复杂规则引擎（表达式/脚本）
- 真正的批量导出
- Python Worker 实际通信

## 3. 技术选型与决策

### 3.1 候选方案

1. 推荐：Tauri + Vue 3 + TypeScript + Vite
2. 备选：Electron + Vue/React
3. 备选：PySide6（纯 Python UI）

### 3.2 选型结论

采用 `Tauri + Vue 3 + TypeScript`。  
原因：跨平台（Windows/macOS）支持成熟、包体更小、性能更好，且适合后续接入 Python 本地处理进程。

## 4. 总体架构

- 桌面容器层：Tauri
- 前端交互层：Vue 3 + TypeScript
- 处理引擎层：Python Worker（Phase 1 仅保留接口位）

职责划分：

- 前端：配置编辑、文件导入、任务控制、状态展示
- Tauri：文件系统能力、对话框、后续进程生命周期管理
- Python（后续）：Excel 规则处理、拆分与导出

## 5. 信息架构与模块拆分

### 5.1 页面布局

- 左侧 `ConfigPanel`
  - 拆分模式（占位）
  - 目标工作表（占位）
  - 输出命名规则（占位）
  - 导出目录（占位）
  - 配置保存/加载（占位）
- 右侧 `WorkspacePanel`
  - 文件导入区（拖拽/点击）
  - 执行区（开始按钮、进度）
  - 结果区（模拟分表清单）

### 5.2 代码模块

- `src/pages/MainPage.vue`
- `src/components/config/*`
- `src/components/workspace/*`
- `src/stores/config.ts`
- `src/stores/task.ts`
- `src/services/file.ts`
- `src/services/mock-engine.ts`
- `src/types/*`

## 6. 数据流与状态机

流程：

1. 用户选择 Excel 文件
2. 前端写入文件元数据并进入 `ready`
3. 用户点击开始处理
4. 调用 `mock-engine`，进入 `running`
5. 返回模拟结果，进入 `success`
6. 结果区展示模拟输出列表

状态定义：

- `idle`：初始状态
- `ready`：可执行
- `running`：执行中
- `success`：执行完成
- `error`：执行失败

约束：

- 仅 `ready` 且校验通过时允许开始
- `running` 时禁止重复触发
- 重新选择文件后重置结果并回到 `ready`

## 7. 错误处理策略

- 文件类型校验：仅允许 `.xlsx/.xls`
- 文件读取失败：错误提示 + 重试入口
- 模拟执行失败：进入 `error`，保留配置，允许重试
- 提示规范：
  - 可恢复错误：轻提示 + 下一步操作引导
  - 不可恢复错误：错误面板 + 摘要日志

## 8. 测试策略

单元测试：

- 配置校验逻辑
- 任务状态机流转
- 模拟引擎进度与结果结构

组件测试：

- 左侧配置可编辑性与控件状态
- 右侧导入、执行、结果展示

手动冒烟：

- 正常流程：选文件 -> 执行 -> 展示模拟结果
- 异常流程：非法文件 -> 报错
- 防抖流程：执行中重复点击被拦截

## 9. 里程碑（Phase 1）

1. 工程初始化（Tauri + Vue + TS）
2. 主页面与左右布局落地
3. 文件导入与任务状态机
4. 模拟执行与结果面板
5. 基础错误处理与测试补齐

## 10. Phase 2 预留（拿到数据模板后）

- 接入 Python Worker（进程通信方案定稿）
- 实现规则 1：按单列拆分
- 实现规则 2：多条件组合拆分（AND/OR）
- 预留规则 3：表达式/脚本扩展点
- 实际导出与日志落盘

## 11. Phase 1 验收标准（DoD）

- 启动应用后可看到左配置、右工作区双栏布局
- 可通过点击或拖拽选择本地 `.xlsx/.xls` 文件
- 非法文件会被拦截并提示原因
- 点击“开始处理”后出现可见进度，且运行中不可重复触发
- 处理结束后可展示模拟输出文件列表（至少 2 条）
- 任意阶段出错可进入 `error` 并支持重试

## 12. Python 接口预留契约（草案）

Phase 1 不实现 Python 通信，但在前端服务层预留统一接口：

- `startTask(payload): Promise<TaskRunResult>`
- `cancelTask(taskId): Promise<void>`
- `onProgress(callback): Unsubscribe`

`payload` 字段草案：

- `inputFilePath: string`
- `splitMode: "single_column" | "multi_conditions"`
- `conditions: Array<{ field: string; op: string; value: string }>`
- `outputDir: string`

说明：

- Phase 1 的 `mock-engine` 与未来 `python-engine` 均实现同一接口，调用方无需改动
- 通过接口隔离，避免在接入真实引擎时侵入 UI 组件
