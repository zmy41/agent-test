# 工单报工 CLI — 按月统计与 CSV 导出 技术设计方案（02-design）

> 角色产出：架构师。输入：docs/workorder-monthly-csv/01-prd.md + 调度者规格门禁裁决（Q-1 只做月度明细导出；Q-2 年月必填；Q-3 带 BOM 的 UTF-8；Q-4 导出不带筛选；Q-5 空月不报错）。本文档精确到可照做实现的程度；不含实现代码。
> 既有系统沿用 docs/workorder/02-design.md 的三模块结构（workorder.js / logic.js / store.js），本期不改 store.js、不改既有命令行为与既有输出；本目录 FR-x / AC-x / TASK-x 编号从 1 重新开始。

## 1. 方案概述

在既有 CLI 上新增两个只读子命令：`stat <年月>`（按月合计：报工笔数、合格总数、不良总数）与 `export <年月>`（该月报工明细 CSV，首字符带 UTF-8 BOM，经 stdout 输出）。实现完全复用既有架构：年月校验、月度行集归集、月合计、CSV 转义与生成全部做成 `logic.js` 纯函数（无 I/O）；`workorder.js` 只做命令编排与输出组装，不写盘。导出成功时输出 = BOM + 纯 CSV 文本（无任何提示语），失败时 stdout 为空、仅 stderr 一行中文错误且退出码非 0，不存在残缺 CSV。

## 2. 技术选型与理由（遵循调度者约束）

| 选型 | 理由 |
|---|---|
| 沿用三模块，不新增源码文件；CSV/月度函数并入 `logic.js` | 最小规模；二者均为纯文本变换（无 I/O），符合 logic.js 既有定位，不设 csv.js |
| 新命令沿用手写 `parseArgs`（`COMMAND_SPECS` 增两行） | 子命令 + 1 个位置参数、无选项，零依赖参数解析即可 |
| 月归集用字符串前缀比较（`report.date.slice(0, 7) === 年月`） | 报工日期在录入时已校验为 YYYY-MM-DD 真实日历日，前 7 位即所属月份；不引入任何日期解析库/对象 |
| 行序用稳定排序（Node/V8 的 `Array.sort` 保证稳定）按 date 单键升序 | 稳定排序自动保留"同日按录入先后"，等价既有 detail/query 口径 |
| CSV 转义/生成手写约 40 行纯函数（`csvEscape` + `toCsv`） | 只需 RFC 4180 式"引号包裹 + 引号双写"，零第三方依赖 |
| BOM 以字符串首字符 `'\uFEFF'` 加在编排层 | `process.stdout.write` 按 UTF-8 编码，`'\uFEFF'` 自然落为 EF BB BF 三字节，无需操作字节流 |
| 测试 `node:test`（`node --test`），通过 `run(argv, opts)` 注入临时数据文件 | 与既有测试模型一致，无需 child_process；文件获取方式见 §5-3（cmd 重定向） |
| `stat`/`export` 均不调用 `save` | 只读推导；PRD 明确"对既有数据只读使用"，也天然杜绝写盘失败污染导出 |

## 3. 模块与文件划分（相对仓库根目录）

```
logic.js                             改动：新增 5 个纯函数导出（既有 12 个函数与全部行为不动）
workorder.js                         改动：COMMAND_SPECS 增 stat/export 两键；新增 doStat/doExport；
                                     run() switch 增 2 分支；新增 1 条年月错误文案与 1 条空月提示常量；
                                     USAGE_ERROR 等既有常量与既有函数均不变
store.js                             不改动
test/logic.test.js                   扩展：月度与 CSV 纯函数单元测试
test/cli.test.js                     扩展：stat/export 命令级测试
test/acceptance-month-csv.test.js    新增：本目录 AC-1~AC-12 端到端验收（沿用既有 acceptance-*.test.js 约定）
```

不设新源码文件、不加依赖；package.json 不动（`scripts.test` 仍为 `node --test`）。

## 4. 接口定义

### 4.1 CLI 命令

```
node workorder.js stat <年月YYYY-MM>
node workorder.js export <年月YYYY-MM>
```

- 年月必填（Q-2）：位置参数恰好 1 个；缺省/多余 → 既有用法错误（`COMMAND_SPECS.positional: 1`），退出码 1。**不存在"默认当月"**，实现不读取系统时间（既有 `now` 仅 create 使用）。
- 成功：结果写 stdout，退出码 0；错误：一行 `错误：<原因>` 写 stderr，退出码 1（沿用全系统口径）。
- `stat` 成功输出（有数据时，恰三行，末尾单换行）：

  ```
  报工笔数：3
  合格总数：75
  不良总数：3
  ```

- `stat` 空月输出（Q-5，退出码 0）：`（该月无报工记录）`
- `export` 成功输出（Q-1/Q-3/Q-4）：stdout 恰为 `'\uFEFF'` + 以下 CSV 文本（末尾恰一个换行，行内无多余空白）：

  ```
  日期,工单号,操作工,合格数量,不良数量
  2026-11-12,WO-20261112-01,张三,30,2
  2026-11-12,WO-20261112-01,王五,5,0
  ```

  空月时恰为 `'\uFEFF'` + 仅表头一行（Q-5，退出码 0）。BOM 为编码标记而非内容；任何 CSV 解析器/Excel 均先剥离再解析。
- 错误文案表（新增部分；其余沿用 docs/workorder/02-design.md §4.1）：
  - 年月格式错或月份无效：`错误：年月无效，须为 YYYY-MM 且月份为 01-12：<输入>`（stat/export 共用；失败时 stdout 为空）
  - 年月缺省：既有 `错误：用法不正确，子命令：create|report|list|detail|query`（**保持原字符串不变**，理由与选项见开放问题 1）
  - 数据文件损坏：既有文案（stat/export 只读，同样先 load 后判损坏）

### 4.2 logic.js 新增导出（全部纯函数，无 I/O）

```js
isValidYearMonthStr(s)
// true 仅当 s 为字符串且匹配 ^\d{4}-(0[1-9]|1[0-2])$；
// 不校验年份范围（0000-9999 均接受），无过去/未来限制（沿用"日期不做业务限制"口径）。
// 2026-13 / 2026-00 / 2026-1 / 202601 / abc / '' / null → false。

queryMonthReports(data, yearMonth)
// yearMonth 须已通过 isValidYearMonthStr（调用方先校验，函数内不再重复校验）。
// 遍历 data.orders（数组序=创建顺序）× order.reports（数组序=录入顺序），
// 取 report.date.slice(0, 7) === yearMonth 的记录，汇总为
// [{ orderId, date, worker, okQty, badQty }]；
// 随后按 date 升序做稳定排序（比较器仅比 date；稳定排序保证同日保持遍历顺序）。
// 不修改入参；返回新数组。

summarizeMonth(rows)
// -> { count: rows.length, okQty: Σ r.okQty, badQty: Σ r.badQty }
// 数量按记录实际值直加，不封顶不剔除（沿用"单笔超额不封顶"口径）。

csvEscape(field)
// String(field) 后：含英文逗号 / 双引号 / \r / \n 之一 → 首尾包裹双引号，
// 且内部每个双引号写两个；否则原样返回。

toCsv(rows)
// -> '日期,工单号,操作工,合格数量,不良数量\n'
//    + rows 每行 [r.date, r.orderId, r.worker, r.okQty, r.badQty].map(csvEscape).join(','),
//      行间以 '\n' 连接，整个字符串以恰一个 '\n' 结尾。
// rows 为空数组时仅返回表头行（含末尾换行）。行分隔用 \n（与全系统输出口径一致，
// Excel/WPS 等常见表格软件均正常解析；RFC 4180 的 CRLF 不强制采用）。
```

### 4.3 workorder.js 变更（编排层）

```js
// COMMAND_SPECS 增加两个键（既有键不动）：
stat:   { positional: 1, flags: [] }
export: { positional: 1, flags: [] }

// 新增常量：
const NO_MONTH_RECORDS_HINT = '（该月无报工记录）';
// 年月错误文案：`错误：年月无效，须为 YYYY-MM 且月份为 01-12：${ym}`（stat/export 共用）

function doStat(data, yearMonth)          // -> { code, out, err }
// 1. !logic.isValidYearMonthStr(yearMonth) → fail(年月错误文案)
// 2. rows = logic.queryMonthReports(data, yearMonth)
// 3. rows.length === 0 → succeed(`${NO_MONTH_RECORDS_HINT}\n`)
// 4. t = logic.summarizeMonth(rows)
//    → succeed(`报工笔数：${t.count}\n合格总数：${t.okQty}\n不良总数：${t.badQty}\n`)

function doExport(data, yearMonth)        // -> { code, out, err }
// 1. !logic.isValidYearMonthStr(yearMonth) → fail(年月错误文案)
// 2. rows = logic.queryMonthReports(data, yearMonth)
// 3. succeed('\uFEFF' + logic.toCsv(rows))   // BOM 只加在成功输出首字符；err 恒为 ''

// run() switch 增加 case 'stat' / case 'export'，均为只读分支，不调用 saveOr。
```

`module.exports` 不变（仍为 `{ parseArgs, run }`）；既有 `fail`/`succeed`/`saveOr` 复用。

## 5. 关键数据流

1. **只读命令生命周期（stat/export 共用）**：`parseArgs → resolveDataPath → load（损坏即错误返回）→ 年月校验（失败即错误返回，stdout 为空）→ queryMonthReports 纯推导 → 格式化输出`。全程不写盘、不依赖 `now`（Q-2：无默认当月）；校验失败发生在任何输出生成之前，故 AC-4/AC-9 的 stdout 必为空。
2. **行序口径（FR-2"与工单明细口径一致"）**：按 orders 创建顺序 × reports 录入顺序遍历并过滤 → 按 date 升序稳定排序 ⇒ 等价"先按报工日期升序，同日按录入先后"。单工单场景与 detail 输出一致（AC-6）；同日跨工单按工单创建顺序（数据模型无全局录入序号，见风险 3）。
3. **导出纯净性与获取方式（Q-3）**：成功时 `out = '\uFEFF' + CSV 文本`、`err = ''`、code 0——stdout 可整体当作 CSV 解析（BOM 为标准编码标记）。**结果获取规定为 stdout 重定向存文件，且必须用 cmd 原样字节重定向**：`cmd /c "node workorder.js export <年月> > <文件>.csv"`。禁止经 Windows PowerShell 5.1 的 `>`（会转写为 UTF-16LE）或中文 Windows 上 pwsh 7 的默认重定向（按 GBK 解码原生进程输出后再转码）转存，否则 BOM/UTF-8 字节失真（详见风险 1；AC-12 验收按本规定方式取文件）。
4. **空月口径（Q-5）**：统计 → `（该月无报工记录）` 退出码 0，无伪造数字；导出 → BOM + 仅表头一行，退出码 0。均与既有"空日查询不报错"口径一致。
5. **月份隔离（AC-5）**：归集键为每笔报工自身 `report.date` 前 7 位，与工单创建时间、数据文件中其它月份记录完全无关。

## 6. 需求覆盖表（AC-x → 满足模块/接口 → 验证位置）

| AC | 验证点 | 满足方式 | 测试 |
|---|---|---|---|
| AC-1 | 月度合计 笔数3/合格75/不良3 | `stat` 编排 + `queryMonthReports`（按报工日期月份归集）+ `summarizeMonth`（直加） | logic + cli + acceptance |
| AC-2 | 跨工单合并 2/40/2 | `queryMonthReports` 遍历全部 orders，不分工单展示 | logic + acceptance |
| AC-3 | 空月提示、退出码 0 | `doStat` rows 为空 → `（该月无报工记录）` | cli + acceptance |
| AC-4 | 六类非法年月拒绝（统计） | `isValidYearMonthStr`（格式/01-12）+ 缺省走 `positional!==1` 用法错误；均 code 1 且 stdout 无数字 | logic + acceptance |
| AC-5 | 月份隔离互不混入 | `queryMonthReports` 前 7 位字符串相等过滤 | logic + acceptance |
| AC-6 | 表头五列、3 数据行、行序 | `toCsv` 表头常量 + `queryMonthReports` 行序口径（日期升序稳定排序） | logic + acceptance |
| AC-7 | 逗号/引号转义不失真 | `csvEscape`（引号包裹 + 引号双写），解析后列数与原值不变 | logic + acceptance |
| AC-8 | 空月仅表头一行 | `doExport` rows 为空 → BOM + 表头 | cli + acceptance |
| AC-9 | 非法年月拒绝（导出） | 同 AC-4 校验；失败路径 stdout 为空（无表头无数据行） | cli + acceptance |
| AC-10 | 输出纯净 1 表头+3 数据行 | `doExport` 成功 out 仅 BOM+CSV、err=''；自动化断言先剥离 BOM 再按行比对 | cli + acceptance |
| AC-11 | 既有 query/list 不受影响 | stat/export 为独立只读分支，既有代码路径零改动；既有 test/*.test.js 全绿 + 回归抽查用例（D1 两笔、列表 75/3/75%/进行中） | acceptance + 既有套件 |
| AC-12 | Excel 中文不乱码（BOM UTF-8） | `'\uFEFF'` 前缀经 UTF-8 编码即 EF BB BF；自动化断言写临时文件后校验首三字节与 UTF-8 内容回读一致；Excel 实开按 §5-3 规定方式取文件后人工判定 | acceptance（字节级）+ 人工 |

FR 覆盖：FR-1 → `stat`/`doStat`/`isValidYearMonthStr`/`queryMonthReports`/`summarizeMonth`；FR-2 → `export`/`doExport`/`csvEscape`/`toCsv`/§5-3 获取方式；FR-3 → 沿用 `fail`/`succeed` 纯文本与错误口径，stat/export 只读，既有五命令与既有输出零改动。

## 7. 任务拆解（每条一次派发可完成；编号贯穿后续 BUG-x/回归环节）

| # | 做什么 | 涉及文件 | 对应 FR/AC |
|---|---|---|---|
| TASK-1 | logic.js 月度纯函数：`isValidYearMonthStr` / `queryMonthReports` / `summarizeMonth` 及单元测试（2026-13/2026-00/2026-1/202601/abc/缺省等边界；AC-5 月份隔离；AC-2 跨工单；同日跨工单行序=创建顺序） | logic.js, test/logic.test.js | FR-1, AC-1/2/4/5 |
| TASK-2 | logic.js CSV 纯函数：`csvEscape` / `toCsv` 及单元测试（空 rows 仅表头；含逗号/双引号/换行字段转义与解析回验；普通字段不加引号；末尾恰一个换行） | logic.js, test/logic.test.js | FR-2, AC-6/7/8 |
| TASK-3 | workorder.js 接入 `stat`：COMMAND_SPECS 增键、年月错误文案、`doStat`（空月提示/三行合计）、run 分支；CLI 测试（AC-1~AC-5 命令级；缺省年月走既有用法错误；非法年月 stdout 为空） | workorder.js, test/cli.test.js | FR-1/3, AC-1/2/3/4/5 |
| TASK-4 | workorder.js 接入 `export`：`doExport`（BOM 前缀、纯净输出、失败无残缺 CSV）；CLI 测试（表头/行序/转义/空月/非法月/纯净性/BOM 存在） | workorder.js, test/cli.test.js | FR-2, AC-6~10 |
| TASK-5 | 验收收尾：新增 test/acceptance-month-csv.test.js 按 AC-1~AC-12 端到端（含 AC-11 既有 query/list 回归抽查、AC-12 写临时 .csv 校验 EF BB BF 三字节与中文内容回读）；pwsh 于仓库根执行 `node --test` 确认新旧用例全绿 | test/acceptance-month-csv.test.js | AC-1~AC-12 |

依赖关系：TASK-1、TASK-2 相互独立可并行；TASK-3 依赖 TASK-1；TASK-4 依赖 TASK-1 与 TASK-2；TASK-5 依赖 TASK-3、TASK-4 收尾。

## 8. 风险与开放问题

**风险**
1. **Windows shell 重定向编码（最高风险）**：Windows PowerShell 5.1 的 `>` 将原生进程输出转写为 UTF-16LE；中文 Windows 上 pwsh 7 默认按 GBK（代码页 936）解码原生输出再转码——两者都会破坏 BOM/UTF-8 字节，导致 AC-12 失真。缓解：§5-3 已规定唯一获取方式 `cmd /c "... > 文件.csv"`（字节原样），验收据此执行。
2. **BOM 与 AC-10"整体按 CSV 解析"**：输出含 BOM 时，朴素逐行比对会把 `\uFEFF` 计入首字段。设计已注明：BOM 属编码标记非内容，自动化断言先剥离 BOM 再解析；Excel 与常见 CSV 解析器均自动剥离，两者不冲突。
3. **同日跨工单"录入先后"不可精确还原**：reports 无时间戳/全局序号，数据模型无法表达跨工单录入先后。本设计沿用既有 `query` 命令口径（工单创建顺序 → 同工单录入顺序）；现有 AC-1~AC-12 未覆盖同日跨工单场景，如产品要求全局录入序需给 report 增加时间戳（超出本期最小规模）。
4. **字段级脏数据**：月过滤为纯字符串前缀比较，手工编辑导致的非法 date（浅校验范围外）不额外校验——与 store.js 既有损坏判定哲学一致。
5. **CSV 字段含换行/回车**：`csvEscape` 已按通用规则覆盖 `\r`/`\n`（防御性支持；Windows CLI 传参实际很难包含换行，但 PRD 明确要求该转义）。

**开放问题（请调度者裁决）**
1. **USAGE_ERROR 文案是否补全为含 stat|export**：既有 test/cli.test.js 与 test/acceptance.test.js 各有 1 处精确断言该字符串。本期默认**保持旧文案不变**（严格满足"不改既有对外行为"、既有用例零改动；代价是带新命令的用法错误提示未列 stat/export）；如希望提示完整，需同步更新这 2 处常量（属有意变更，非回归）。默认按"不变"实现。
2. **用户可见文案**：`（该月无报工记录）`、统计三行 `报工笔数：N` / `合格总数：X` / `不良总数：Y`、年月错误 `错误：年月无效，须为 YYYY-MM 且月份为 01-12：<输入>`、命令名 `stat`/`export` 均为本设计拟定（PRD 授权架构文档定命令形式）；如产品另有措辞，修订本文档 §4 后再实现。
3. **导出获取方式**：本期定为 stdout 重定向（§5-3）。如需 `export <年月> --out <文件路径>` 直写文件以彻底绕开 shell 编码风险，请裁决；按最小规模默认不做。
