# 生产工单报工小系统 — 技术设计方案（02-design）

> 角色产出：架构师。输入：docs/workorder/01-prd.md + 调度者裁决。本文档精确到可照做实现的程度；不含实现代码。
> 裁决落实：①单笔超额允许（累计合格可超计划、随即完工、进度可 >100% 不封顶）；②报工日期允许补录过去/预录未来，仅校验 YYYY-MM-DD 格式且为有效日历日期；③数据文件存在但损坏 → 明确报错、不覆盖、不重建；文件不存在 → 按空数据启动。

## 1. 方案概述

单进程 Node.js CLI，入口 `workorder.js`，五个子命令（create / report / list / detail / query），一次性命令模型：每次调用 = `store.load()` 读盘 → `logic.js` 纯函数校验与计算 → 内存变更 → `store.save()` 立即写盘 → 纯文本输出并退出。状态与累计数不落盘，统一由报工记录数组推导，杜绝状态不一致；所有校验在任何写盘前完成，天然满足"拒绝即无任何数据变更"。数据为单个 JSON 文件（默认运行目录 `data.json`，可用 `WORKORDER_DATA_FILE` 覆盖）。

## 2. 技术选型与理由（遵循调度者约束）

| 选型 | 理由 |
|---|---|
| Node.js + CommonJS，零第三方依赖 | 最小可用规模；require/module.exports 即可，无需构建 |
| 内置模块仅用 `fs` / `path` / `os`（测试用） | 读盘/写盘/路径拼接的最小集合 |
| 参数解析手写（约 30 行，位于 `workorder.js` 的 `parseArgs`） | 避免 argv 解析框架；子命令 + 位置参数 + `--k v` 选项足够 |
| 同步 I/O（`readFileSync` / `writeFileSync`） | 一次性命令进程，无需异步复杂度；"操作成功后即写入"语义最直接 |
| 测试框架 `node:test`，`node --test` 执行 | 宿主已确认 Node v24.16.0，内置支持；不引第三方测试库 |
| 状态/累计数推导而非存储 | 单一事实来源（reports 数组），AC-12 重启一致性与 FR-5 自动流转零成本满足 |
| 无并发控制 | PRD 非目标明确"单机、单人串行使用" |

## 3. 模块与文件划分（相对工作区根目录）

```
workorder.js        CLI 入口：parseArgs、五命令编排、输出与退出码、run(argv, opts) 可测入口
logic.js            纯领域逻辑：日期/数量校验、工单号生成、状态与累计推导、排序、筛选（无 I/O）
store.js            数据文件 I/O：路径解析、加载（含损坏判定）、保存
package.json        仅 name + scripts.test = "node --test"
test/logic.test.js  logic.js 单元测试
test/store.test.js  store.js 单元测试（缺失/正常/损坏/覆盖路径）
test/cli.test.js    端到端测试：直接调用 run()，用临时目录数据文件与注入 now 模拟多日/重启
```

不设 src/ 目录（文件总数 ≤4，根目录即可）；无其他文件。

## 4. 接口定义

### 4.1 CLI 命令（纯文本输出，列分隔符为 ` | `）

```
node workorder.js create <产品名称> <计划数量>
node workorder.js report <工单号> <日期YYYY-MM-DD> <操作工> <合格数量> <不良数量>
node workorder.js list
node workorder.js detail <工单号>
node workorder.js query <日期YYYY-MM-DD> [--wo <工单号>] [--worker <操作工>]
```

- 成功：结果写 stdout，退出码 0；错误：一行 `错误：<原因>` 写 stderr，退出码 1（统一 1，便于脚本判定）。
- 空结果不算错误：list 空输出 `（暂无工单）`；query/detail 无记录输出 `（无报工记录）`，退出码 0（AC-10/11/15）。
- 各命令输出行：
  - list：表头 `工单号 | 产品 | 计划 | 累计合格 | 累计不良 | 进度 | 状态`，每工单一行，按 orders 数组顺序（即创建顺序，等价 PRD "按工单号升序"）。
  - detail：首行同 list 行格式（含该工单聚合），随后每条记录一行 `日期 | 操作工 | 合格 | 不良`，按"日期升序、同日按录入先后"稳定排序。
  - query：每条一行 `日期 | 工单号 | 操作工 | 合格 | 不良`，按工单创建顺序、同工单按录入先后。
  - create 成功输出：`已创建：<工单号>`；report 成功输出：`报工成功：<工单号>（累计合格 X，累计不良 Y，状态：Z）`。
- 错误文案表（可区分，AC-9/AC-3/AC-6/AC-7 依据）：
  - 用法错误（无/未知命令、参数个数不符、未知选项）：`错误：用法不正确，子命令：create|report|list|detail|query`
  - `错误：数据文件已损坏，已拒绝读写：<路径>（请人工处理后重试）`
  - `错误：数据文件写入失败：<路径>（请确认目录存在且可写后重试）`（修复轮 1 新增，调度者裁决：写盘异常在编排层捕获，符合 FR-9 明确报错要求，且不产生任何数据变更）
  - `错误：产品名称不能为空` ／ `错误：计划数量必须为正整数：<输入>`
  - `错误：工单不存在：<工单号>` ／ `错误：工单已完工，拒绝报工：<工单号>`
  - `错误：操作工不能为空` ／ `错误：报工日期无效，须为 YYYY-MM-DD 的有效日历日期：<输入>`
  - `错误：合格数量不能为负数` ／ `错误：合格数量必须为不小于 0 的整数`（不良数量同理，前缀"不良"）
  - `错误：合格数与不良数不得同时为 0`

### 4.2 数据文件格式（JSON，schema 即损坏判定依据）

```json
{
  "version": 1,
  "orders": [
    { "id": "WO-20261112-01", "product": "支架", "planQty": 100,
      "reports": [ { "date": "2026-11-12", "worker": "张三", "okQty": 30, "badQty": 2 } ] }
  ],
  "seq": { "20261112": 2 }
}
```

- `orders` 数组只追加，天然保持创建顺序；`reports` 数组只追加，天然保持录入先后（配合稳定排序实现 AC-5）。
- 不落盘 status / 累计合格 / 累计不良：读取时由 `logic.computeStatus` / `logic.totals` 推导。
- `seq`：`YYYYMMDD -> 当日已用工单序号`，跨日自动重置；序号 >99 时 `padStart(2)` 自然扩位（如 `-100`）。
- 损坏判定（裁决 3）：文件存在但 ①`JSON.parse` 失败，或 ②根不是普通对象 / `orders` 不是数组 / `seq` 不是对象 → 判为损坏。浅校验即可，不逐条校验记录字段（字段级脏数据属手工编辑，PRD 非目标）。

### 4.3 store.js 函数签名

```js
resolveDataPath(cwd, env)            // env.WORKORDER_DATA_FILE 非空字符串 → 直接用该值；否则 path.join(cwd, 'data.json')
load(filePath)
  // 文件不存在          → { ok: true,  data: { version: 1, orders: [], seq: {} } }   （裁决 3：空数据启动）
  // 存在且解析通过      → { ok: true,  data }                                        （data 为解析结果）
  // 存在但判为损坏      → { ok: false, reason: '损坏' }                              （绝不写回该文件）
save(filePath, data)                 // fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')；由 run() 在全部校验通过后调用
```

### 4.4 logic.js 函数签名（全部纯函数，无 I/O）

```js
const STATUS = { PENDING: '待开工', DOING: '进行中', DONE: '已完成' }
formatDateKey(date)                  // Date -> 'YYYYMMDD'（本地时区）
isValidDateStr(s)                    // true 仅当 ^\d{4}-\d{2}-\d{2}$ 且为真实日历日（用 Date.UTC 反解校验月/日，2026-02-30 → false）；不做过去/未来限制（裁决 2）
parseQty(s)                          // -> { kind:'ok', value:int } | { kind:'neg' }（^-?\d+$ 且 <0）| { kind:'nonInt' }（非整数格式）
validateCreate(name, planStr)        // -> { ok:true, product, planQty } | { ok:false, message }（名称非空；计划数量为正整数）
generateOrderId(dateKey, seqN)       // -> 'WO-<dateKey>-<padStart(2) 序号>'
makeOrder(id, product, planQty)      // -> { id, product, planQty, reports: [] }
findOrder(data, id)                  // -> order | undefined（按 id 精确匹配）
computeStatus(order)                 // reports.length===0 → '待开工'；ΣokQty >= planQty → '已完成'（可 >plan，裁决 1）；否则 '进行中'
totals(order)                        // -> { okQty, badQty }（Σ reports）
sortDetailReports(reports)           // -> 新数组：按 date 字符串升序稳定排序，同日保持原数组（录入）顺序
queryReports(data, dateStr, filter)  // filter:{wo?, worker?}；遍历 orders×reports，date 相等 &&（有 wo 则 id 相等）&&（有 worker 则 worker 相等）
                                     // -> [{ orderId, date, worker, okQty, badQty }]
```

### 4.5 workorder.js 可测入口

```js
parseArgs(argv)   // argv 为去掉 node 与脚本名的参数数组；-> { cmd, positional:[], flags:{} } | { error: message }
                  // 规则：首 token 为子命令；'--' 开头 token 取下一 token 为值（缺值 → error）；其余按序入 positional
run(argv, opts)   // -> { code: 0|1, out: string, err: string }
                  // opts: { cwd?, env?, now?: Date }，缺省分别取 process.cwd() / process.env / new Date()
                  // 流程：parseArgs → resolveDataPath → load（失败即损坏错误返回）→ 按命令校验并变更内存数据 → save → 组装 out/err
if (require.main === module) { const r = run(process.argv.slice(2)); r.out && process.stdout.write(r.out); r.err && process.stderr.write(r.err); process.exit(r.code); }
module.exports = { parseArgs, run }
```

测试通过 `run()` 注入临时 cwd/dataFile/now 完成；每次 run 都重新读盘再写盘，"连续多次 run 指向同一数据文件"即等价 PRD 的"重启"（AC-12），无需 child_process。

## 5. 关键数据流与状态流转

1. **单笔命令生命周期**：`parseArgs → load → 校验（全过才动数据）→ 变更内存 data → save → 输出`。任何校验失败在 save 前返回，磁盘必然不变（FR-6"不产生任何数据变更"由流程结构保证，而非回滚）。
2. **报工校验顺序**（首个失败即返回对应文案）：工单存在 → 未完工 → 操作工非空 → 日期合法 → 合格数 → 不良数 → 不同时为 0。
3. **状态机**（全程由 `computeStatus` 从 reports 推导，无手工改状态入口）：
   `待开工（0 笔报工）→ 任一笔成功报工 → 进行中 → 累计合格 ≥ 计划 → 已完成`；
   允许待开工一笔直达已完成（首笔即 ≥ 计划）；累计合格可超计划（随即已完成，进度照实 >100%）；已完成后再报工在校验第 2 步被拒。
4. **工单号生成**：`seq[formatDateKey(now)] = (旧值||0)+1`，拼 `WO-<YYYYMMDD>-<NN>`，随 create 一并落盘；跨日键不同自然归 01（AC-2）。
5. **数据文件选择**：`WORKORDER_DATA_FILE` 有值则完全接管路径，默认 `data.json` 全程不被触碰（AC-14）；无值则用运行目录 `data.json`（AC-13）。

## 6. 需求覆盖表（AC → 满足模块/接口 → 验证位置）

| AC | 验证点 | 满足方式 | 测试 |
|---|---|---|---|
| AC-1 | 创建成功、初始状态与列表聚合 | create 编排 + `validateCreate`/`generateOrderId`/`makeOrder` + list 格式化（推导合计） | test/cli.test.js |
| AC-2 | 当日序号递增、跨日重置 | `generateOrderId` + `seq` 键；跨日用 `run` 注入 `now` 模拟次日 | cli + logic |
| AC-3 | 创建非法输入拒绝 | `validateCreate`（名称空 / 0 / -5 / 2.5 / abc 均拒绝，总数不变） | logic + cli |
| AC-4 | 两笔报工后列表聚合 | report 编排 + `totals` 推导 | cli |
| AC-5 | 详情 3 条及排序 | detail + `sortDetailReports` 稳定排序（D1 张三、D1 王五、D2 李四） | logic + cli |
| AC-6 | 报工/详情对不存在工单报错 | `findOrder` + 统一 `错误：工单不存在：<id>`，报工与 detail 均在写盘前返回 | cli |
| AC-7 | 达标自动完工并拒绝后续 | `computeStatus` 推导已完成；report 校验第 2 步拒绝；累计与记录数不变 | logic + cli |
| AC-8 | 单笔超额 120%、120%、已完成 | 裁决 1：`computeStatus` 用 `>=`，进度 `Math.round(ok/plan*100)` 不封顶 | logic + cli |
| AC-9 | 七类非法报工逐项可区分拒绝 | §4.1 错误文案表 + `parseQty`/`isValidDateStr`；校验在 save 前完成，三数均不变 | logic + cli |
| AC-10 | 按日查询与空日提示 | `queryReports`（仅 date 条件）；空 → `（无报工记录）`，退出码 0 | logic + cli |
| AC-11 | 工单号/操作工/组合筛选 | `queryReports` filter 两个条件 AND；组合无命中 → 空提示不报错 | logic + cli |
| AC-12 | 重启后数据完整 | 每次命令 `load→save` 全量往返；测试用同一临时文件连续多次 `run` | store + cli |
| AC-13 | 默认运行目录 data.json | `resolveDataPath(cwd, env)` 无 env 时取 cwd/data.json；测试注入临时 cwd | store + cli |
| AC-14 | WORKORDER_DATA_FILE 覆盖 | env 有值即完全接管；默认文件不被创建/修改；同 env 再次 run 可读回 | store + cli |
| AC-15 | 空数据列表提示 | list 空 → `（暂无工单）`，退出码 0，无伪造数据 | cli |

FR 覆盖：FR-1→create/4.2；FR-2→list/computeStatus/totals；FR-3→detail/sortDetailReports；FR-4→report/§5-2；FR-5→§5-3；FR-6→§4.1 文案表；FR-7→query/queryReports；FR-8→store.js/§4.2；FR-9→§4.1 输出约定（全纯文本、错误带原因）。

## 7. 任务拆解（每条一次派发可完成）

| # | 做什么 | 涉及文件 | 对应 FR/AC |
|---|---|---|---|
| TASK-1 | 项目骨架：package.json（scripts.test=`node --test`）；workorder.js 的 `parseArgs` + 命令分发骨架 + 用法错误输出与退出码；logic.js / store.js 建立空导出 | package.json, workorder.js, logic.js, store.js | FR-9 |
| TASK-2 | logic.js 基础函数：`formatDateKey`/`isValidDateStr`/`parseQty` 及单元测试（覆盖 2026-02-30、abc、-1、1.5 等） | logic.js, test/logic.test.js | FR-4, AC-3, AC-9 |
| TASK-3 | store.js：`resolveDataPath`/`load`/`save` 含损坏判定（解析失败、根/orders/seq 结构不符 → 拒绝；缺失 → 空数据）及单元测试 | store.js, test/store.test.js | FR-8, AC-13, AC-14, 裁决3 |
| TASK-4 | logic.js 工单域函数：`validateCreate`/`generateOrderId`/`makeOrder`/`findOrder`/`computeStatus`/`totals`/`sortDetailReports`/`queryReports` 及单元测试 | logic.js, test/logic.test.js | FR-1/2/3/5/7, AC-2/5/7/8/10/11 |
| TASK-5 | workorder.js 实现 create 与 list（含输出格式、空列表提示）及 CLI 测试 | workorder.js, test/cli.test.js | FR-1/2/9, AC-1/2/3/15 |
| TASK-6 | workorder.js 实现 report：六类拒绝文案 + 成功落盘；CLI 测试覆盖超额与各拒绝分支 | workorder.js, test/cli.test.js | FR-4/5/6, AC-4/6/7/8/9, 裁决1/2 |
| TASK-7 | workorder.js 实现 detail 与 query（含 --wo/--worker 筛选、空结果提示）及 CLI 测试 | workorder.js, test/cli.test.js | FR-3/7, AC-5/6/10/11 |
| TASK-8 | 全量验收回归：按 AC-1~AC-15 逐条补齐端到端用例（含 AC-12 连续 run 模拟重启、AC-13/14 文件位置），确认 `node --test` 全绿 | test/cli.test.js 等 | AC-1~AC-15 |

依赖关系：TASK-2、TASK-3 可并行，均依赖 TASK-1；TASK-4 依赖 TASK-2；TASK-5~7 依赖 TASK-3/4；TASK-8 收尾。

## 8. 风险与开放问题

**风险**
1. 工单号序号 >99 扩位后（如 `-100`），字符串排序不再等价创建顺序——设计已规避：列表/查询按 orders 数组（创建顺序）输出，不做 id 字符串排序；PRD 本身声明"工单号升序等价创建顺序"。
2. `save` 用直接 `writeFileSync`，非原子写；进程中途被杀理论可产生损坏文件，届时按裁决 3 报错交人工，本期不做备份/原子替换（PRD 非目标）。
3. 损坏判定为浅校验（结构级）；手工编辑导致的字段级脏数据（如 okQty 为字符串）不在防护范围。
4. Windows 控制台中文显示依赖 Node TTY Unicode 输出（Node 24 无问题）；脚本读取管道输出时为 UTF-8 字节，需 GBK 场景由调用方处理。
5. 测试用 `run()` 注入 cwd/env/now，未覆盖"真实进程环境变量继承"路径——TASK-8 增加 1 条以 `env` 对象模拟 `WORKORDER_DATA_FILE` 的用例缓解（已含于 AC-14 用例）。

**开放问题（请调度者裁决）**
1. `query` 传入无效日期（如 `2026-02-30`）：本设计按错误处理（退出码 1）；PRD 未明说，如需改为"空结果提示"请裁决。
2. 空结果提示的具体文案（`（暂无工单）`/`（无报工记录）`）与输出分隔符（` | `）为本设计拟定的用户可见文案，验收比对时如产品另有措辞请修正本文档 §4.1。
3. create/report 采用位置参数，产品名称含空格需引号；如需 `--name` 长选项形式（不影响任何 AC）请裁决，默认按位置参数实现。
