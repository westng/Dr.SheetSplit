# Dr.SheetSplit

Dr.SheetSplit 是一个基于 Tauri + Vue + TypeScript + Python 的桌面端表格拆分工具，支持可视化规则配置、映射管理、多 Sheet 动态产出、规则引擎表达式计算、本地持久化和自动更新。

GitHub: https://github.com/westng/Dr.SheetSplit

## 核心能力

- 处理表格：导入源表，按规则拆分生成新工作簿
- 配置规则：可视化编辑拆分规则，支持导入/导出规则 JSON
- 映射管理：分组维护映射数据，支持上传、编辑、导入/导出
- 规则引擎：支持来源字段、映射、聚合、条件分流、表达式、日期格式化等模式
- 本地数据存储：规则/映射/设置持久化
- 自动更新：检查更新、一键下载并安装更新
- 国际化：简体中文 / English

## 技术架构

- 前端：Vue 3 + TypeScript + Vite + Vue Router + Vue I18n
- 桌面壳：Tauri 2
- 引擎：Python（`src-tauri/python/transform_engine.py`）
- 表格处理：SheetJS (`xlsx`)
- 本地持久化：
  - 规则：SQLite（`@tauri-apps/plugin-sql`）
  - 映射：Tauri Store（`settings.json`）
  - UI 设置：`localStorage`（外观、语言、导出目录、导入格式等）

## 快速开始

### 1. 环境要求

- Node.js 18+（建议 20+）
- pnpm
- Rust（含 cargo）
- Tauri 运行依赖（按你的系统安装）
- Python 3（仅开发调试可选，发布版走内置运行时）

可选环境变量：

```bash
export DR_SHEETSPLIT_PYTHON=/usr/local/bin/python3
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 本地开发（热更新）

```bash
pnpm tauri dev
```

说明：

- Tauri 会先启动 Vite（默认 `http://localhost:1420`）再启动桌面窗口。
- 保持只启动一个 `pnpm tauri dev` 进程，避免端口冲突。

### 4. 构建

```bash
pnpm build
pnpm tauri build
```

发布包（给最终用户安装）使用内置 Python 运行时，不依赖用户机器预装 Python。  
请在打包前放置对应平台运行时文件：

- macOS: `src-tauri/python/runtime/macos/bin/python3`
- Windows: `src-tauri/python/runtime/windows/python.exe`

说明：

- Release 构建会校验上面路径；缺失会直接报错，防止误发“非内置”安装包。
- 开发模式（`pnpm tauri dev`）仍允许回退系统 Python，便于本地调试。

## 目录结构

```text
.
├─ src/                         # 前端源码
│  ├─ components/               # 业务组件（处理区/规则区/映射区）
│  ├─ pages/                    # 页面与子窗口页面
│  ├─ services/process/         # 处理编排（调用引擎 -> 构建工作簿 -> 写文件）
│  ├─ store/                    # 规则/映射/语言/UI 状态
│  ├─ utils/                    # 校验、解析、模板等工具
│  ├─ composables/              # 外观、更新、导入格式等组合式逻辑
│  └─ locales/                  # i18n 文案
├─ src-tauri/
│  ├─ src/lib.rs                # Tauri 命令：文件读写/更新/调用 Python 引擎等
│  ├─ python/transform_engine.py# 核心拆分引擎
│  └─ tauri.conf.json           # Tauri 配置（窗口、更新、打包资源）
└─ README.md
```

## 处理流程

1. 前端加载源表并选择规则
2. 执行规则兼容性校验（字段、映射分组等）
3. 调用 `run_python_transform` 执行 Python 引擎
4. 前端将引擎输出组装为 xlsx 文件
5. 写入导出目录（默认系统“下载”目录）

## 规则引擎（输出字段取值方式）

当前支持：

- `source`：来源字段
- `constant`：固定值
- `mapping`：映射转换
- `mapping_multi`：多条件映射转换（`字段1+字段2+...`）
- `conditional_target`：条件字段分流（双目标字段）
- `aggregate_sum`：组内求和
- `aggregate_sum_divide`：逐行相除后求和
- `aggregate_join`：组内拼接
- `copy_output`：复制已产出的字段
- `format_date`：日期格式化
- `expression`：表达式计算（高级）

### conditional_target 说明

- 可配置判断字段、映射分组、命中目标字段、未命中目标字段、取值来源字段、聚合方式。
- 优先按映射分组的 `target` 判定写入哪一列；未命中走默认分支。
- 输出时会按每个 Sheet 自动裁剪“整列全空”的条件列，避免出现无效双列。

### expression 说明

支持：

- 运算符：`+ - * /`
- 函数：`sum`、`avg`、`first`、`num`、`join`、`join_unique`、`count`、`count_non_empty`
- 字段名需使用引号，例如：`sum("采购数量") / sum("采购规格")`

示例：

```text
sum("采购数量") / sum("采购规格")
join_unique("采购单号", "\n")
```

## 映射文件格式

映射管理支持导入：

- JSON
- CSV
- XLSX / XLS

要求：

- 表头需可识别 `source` / `target`（支持中英文关键词，如“来源/目标”）。
- JSON 可使用：
  - 数组对象：`[{ "source": "...", "target": "..." }]`
  - 键值对象：`{ "A": "B" }`

## 本地存储与数据

- 规则库：SQLite（数据库名 `rules.db`）
- 映射库：Tauri Store（`settings.json`）
- 外观/语言/导入导出设置：`localStorage`

## 自动更新

已接入 `@tauri-apps/plugin-updater`，默认更新地址：

- `https://github.com/westng/Dr.SheetSplit/releases/latest/download/latest.json`

支持：

- 启动自动检查更新
- 手动检查更新
- 一键下载并安装更新

## 常见问题

### 1) `pnpm tauri dev` 启动失败，提示端口占用

通常是已有 Vite/Tauri 进程占用 `1420`，结束旧进程后重启即可。

### 2) 发布包运行提示找不到 Python

- 检查安装包是否由“内置运行时”构建（见上面的 runtime 路径要求）。
- 若是开发环境运行（`pnpm tauri dev`），可安装系统 Python 或设置 `DR_SHEETSPLIT_PYTHON`。

### 3) 导入文件不可选

检查“设置 -> 导入导出 -> 允许导入文件格式”是否包含该扩展名（内置 `xlsx/xls/csv` 不可删除）。
