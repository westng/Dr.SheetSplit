# 规则引擎详细使用文档

本文档说明 Dr.SheetSplit 规则引擎的实际执行逻辑，包含分组机制、每种取值方式、表达式语法、标题变量冲突策略和常见报错。

## 1. 执行模型

规则引擎执行顺序（简化版）：

1. 读取规则、源表行数据、映射分组
2. 按 `groupByFields[0]` 做动态分组（一个分组对应一个输出 Sheet）
3. 在每个 Sheet 内按 `summaryGroupByFields` 做“汇总分组”
4. 对每个汇总分组计算一次输出列（`outputColumns`）
5. 渲染标题行（若启用）并输出结果

说明：

- 目前动态分组只使用 `groupByFields` 的第一个字段。
- `outputColumns` 的顺序会影响结果（尤其 `copy_output`）。

## 2. 分组与过滤

### 2.1 动态分组 `groupByFields`

- 使用第一个字段值作为 Sheet 名称来源。
- 分组值为空时，使用 `未命名分组`。

### 2.2 动态分组排除 `groupExcludeMode`

支持三种模式：

- `none`：不过滤
- `manual_values`：按 `groupExcludeValuesText`（逗号/空格/换行分隔）排除
- `mapping_group_source`：使用某个映射分组的 `source` 集合作为排除列表

### 2.3 组内汇总 `summaryGroupByFields`

- 为空：每一行都单独产出一行输出。
- 非空：按这些字段组合键分组，每组产出一行输出（聚合模式会在这里生效）。

## 3. 输出列取值方式

### 3.1 `source`（来源字段）

- 配置：`sourceField`
- 行为：取当前汇总分组的第一行该字段值。

### 3.2 `constant`（固定值）

- 配置：`constantValue`
- 行为：直接输出固定文本。

### 3.3 `mapping`（单字段映射）

- 配置：`sourceField` + `mappingSection`
- 行为：
  - 取当前汇总分组第一行 `sourceField`
  - 在映射分组中按 `source -> target` 查找
  - 命中输出 `target`
  - 未命中输出 `unmatchedFallback`（当前流程默认传入 `未知错误`）

### 3.4 `mapping_multi`（多条件映射）

- 配置：`mappingSourceFields[]` + `mappingSection`
- 组合键：`字段1+字段2+...`（固定 `+`）
- 行为：
  - 每个参与字段都取汇总分组第一行值
  - 若同一汇总分组内某参与字段出现不一致值，直接报错并中断
  - 组合键命中映射则输出 `target`
  - 未命中输出固定兜底值：`未知错误填充`

兼容性说明：

- 映射表中 `A+B` 与 `A + B` 都能匹配。
- 字段顺序必须一致（`A+B` 与 `B+A` 视为不同键）。

### 3.5 `conditional_target`（条件字段分流）

- 配置：
  - `conditionalJudgeField`（判断字段）
  - `conditionalMappingSection`（条件映射分组）
  - `conditionalValueSourceField`（实际写入值来源）
  - `conditionalHitTargetField`（命中目标列）
  - `conditionalMissTargetField`（未命中目标列）
  - `conditionalAggregateMode`（`first` / `sum` / `join_newline`）
- 行为：
  - 每行判断 `judgeField` 是否命中映射分组 `source`
  - 命中写入 hit 列，未命中写入 miss 列
  - 最后按聚合模式输出两列结果

后处理：

- 若某个条件列在整个 Sheet 中全空，会被自动裁剪（仅保留有值列）。

### 3.6 `aggregate_sum`（组内求和）

- 配置：`aggregateSourceField`
- 行为：对汇总分组内该字段做数值求和。
- 报错：字段为空或非数字会报错。

### 3.7 `aggregate_sum_divide`（逐行相除后求和）

- 配置：`aggregateNumeratorField` + `aggregateDenominatorField`
- 行为：对每行执行 `分子/分母`，再累加。
- 报错：
  - 非数字
  - 分母为 `0`

### 3.8 `aggregate_join`（组内拼接）

- 配置：`aggregateJoinSourceField` + `aggregateJoinDelimiter`
- 分隔符：
  - `newline`：换行
  - `space`：空格
- 行为：拼接汇总分组内非空值。

### 3.9 `copy_output`（复制产出字段）

- 配置：`copyFromTargetField`
- 行为：复制前面已计算出的目标字段值。
- 注意：依赖输出列顺序；只能复制“前面列”已经产出的值。

### 3.10 `format_date`（日期格式化）

- 配置：`dateSourceField` + `dateOutputFormat`
- 行为：读取汇总分组第一行日期并格式化。
- 支持输入格式（部分）：
  - `YYYY-MM-DD`
  - `YYYY/MM/DD`
  - `YYYY.MM.DD`
  - `YYYY-MM-DD HH:MM[:SS]`
  - `YYYY/MM/DD HH:MM[:SS]`
  - `YYYYMMDD`
  - ISO 时间字符串

### 3.11 `expression`（表达式）

- 配置：`expressionText`
- 支持函数：
  - `sum(field)`
  - `avg(field)`
  - `first(field)`
  - `num(field)`
  - `join(field, delimiter="\n")`
  - `join_unique(field, delimiter="\n")`
  - `count(field?)`
  - `count_non_empty(field)`
- 支持运算符：`+ - * /`，支持一元 `+/-`
- 规则：
  - 字段名用引号包裹，例如 `sum("采购数量")`
  - 不支持关键字参数
  - 除法分母为 0 会报错

示例：

```text
sum("采购数量") / sum("采购规格")
join_unique("采购单号", "\\n")
first("子公司") + "+" + first("物理仓")
```

## 4. 标题模板（Sheet Title）

模板变量格式：`{{变量名}}`

变量取值优先级：

1. 若变量名命中输出字段，取输出值
2. 否则从来源字段取值

冲突处理 `conflictMode`：

- `first`：取第一条
- `last`：取最后一条
- `join_unique`：去重后使用 ` / ` 拼接
- `placeholder`：使用 `placeholderValue`
- `error`：直接报错

## 5. 映射分组数据格式

每个映射分组为 `source -> target` 键值列表：

```json
[
  { "source": "北京子公司+北京生鲜加工中心分仓", "target": "北京生鲜加工中心分仓" }
]
```

建议：

- `mapping_multi` 使用前先固定字段顺序。
- 明确组合键规范，避免同义写法混用。

## 6. 常见报错与排查

### 6.1 多条件映射字段在同组不一致

现象：`多条件映射字段“X”在同一分组内存在不一致值，无法映射。`

排查：

- 检查 `summaryGroupByFields` 是否过粗，导致不同业务行被合并到同一汇总组。
- 必要时增加汇总分组字段，保证映射键字段在组内唯一。

### 6.2 数值计算报错

现象：空值、非数字、分母为 0。

排查：

- 检查源字段原始数据是否可被解析为数字。
- 对分母字段做数据清洗或前置校验。

### 6.3 表达式语法错误

现象：表达式语法错误、函数不支持、参数错误。

排查：

- 确认字段名用引号
- 确认函数名在支持列表中
- 先用简单表达式逐步验证

## 7. 配置示例（节选）

`mapping_multi` 示例：

```json
{
  "targetField": "区域",
  "valueMode": "mapping_multi",
  "mappingSourceFields": ["子公司", "生鲜加工中心分仓"],
  "mappingSection": "region"
}
```

`conditional_target` 示例：

```json
{
  "valueMode": "conditional_target",
  "conditionalJudgeField": "货品ID",
  "conditionalMappingSection": "quantityColumn",
  "conditionalValueSourceField": "采购件数",
  "conditionalHitTargetField": "采购件数（提）",
  "conditionalMissTargetField": "采购件数（瓶）",
  "conditionalAggregateMode": "sum"
}
```
