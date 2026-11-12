# 生产工单报工小系统 — 开发记录（03-dev-notes）

> 角色产出：开发。输入：docs/workorder/02-design.md（唯一实现依据）。
> 范围：设计方案 §7 的 TASK-1 ~ TASK-8 全部任务，覆盖 FR-1~FR-9 / AC-1~AC-15。改动仅落在工作区，未执行任何 git 操作，未安装任何依赖（零第三方依赖，仅 Node 内置模块）。

## 1. 本次完成的 TASK 清单

| # | TASK | 状态 | 产出文件 |
|---|---|---|---|
| TASK-1 | 项目骨架：package.json（scripts.test=`node --test`）、workorder.js 的 parseArgs + 命令分发、logic.js/store.js | 完成 | package.json、workorder.js、logic.js、store.js |
| TASK-2 | logic.js 基础函数：formatDateKey / isValidDateStr / parseQty + 单元测试 | 完成 | logic.js、test/logic.test.js |
| TASK-3 | store.js：resolveDataPath / load / save 含损坏判定 + 单元测试 | 完成 | store.js、test/store.test.js |
| TASK-4 | logic.js 工单域函数：validateCreate / generateOrderId / makeOrder / findOrder / computeStatus / totals / sortDetailReports / queryReports + 单元测试 | 完成 | logic.js、test/logic.test.js |
| TASK-5 | workorder.js 实现 create 与 list（输出格式、空列表提示）+ CLI 测试 | 完成 | workorder.js、test/cli.test.js |
| TASK-6 | workorder.js 实现 report（六类拒绝文案 + 成功落盘）+ CLI 测试（超额与各拒绝分支） | 完成 | workorder.js、test/cli.test.js |
| TASK-7 | workorder.js 实现 detail 与 query（--wo/--worker 筛选、空结果提示）+ CLI 测试 | 完成 | workorder.js、test/cli.test.js |
| TASK-8 | 全量验收回归：按 AC-1~AC-15 逐条补齐端到端用例（AC-12 连续 run 模拟重启、AC-13/14 文件位置），`node --test` 全绿 | 完成 | test/cli.test.js 等 |

源码严格按设计 §3 文件划分：`workorder.js` / `logic.js` / `store.js` / `package.json` 四文件在根目录，测试在 `test/` 下，无其他新增文件。

## 2. 关键实现决定

1. **状态与累计数全部推导、不落盘**（§4.2）：数据文件仅存 `version` / `orders`（含 reports 追加数组）/ `seq`；`computeStatus` / `totals` 读取时推导。orders 与 reports 数组只追加，天然保持创建顺序与录入先后，AC-5 稳定排序由 `sortDetailReports` 的"日期升序 + 原始下标平局判定"实现（不改入参数组）。
2. **校验顺序严格按 §5-2**：工单存在 → 未完工 → 操作工非空 → 日期合法 → 合格数 → 不良数 → 不同时为 0；任何失败在 `save` 前返回，磁盘必然不变（FR-6 由流程结构保证，测试用"文件字节级比对"验证）。
3. **损坏判定（裁决 3）**：文件存在但 JSON.parse 失败，或根非普通对象 / orders 非数组 / seq 非对象 → `{ ok:false, reason:'损坏' }`，浅校验，绝不写回；文件不存在 → 空数据启动。读取阶段的非 JSON 异常（如权限问题）也归入"损坏"，以维持 §4.3 的三出口契约。
4. **parseArgs**（§4.5）：首 token 为子命令；`--` 开头 token 取下一 token 为值（缺值 → 用法错误），选项名去掉 `--` 作为 flags 键（query 仅允许 `wo`/`worker`）；未知选项、缺值、位置参数个数不符统一返回 `错误：用法不正确，子命令：create|report|list|detail|query`。
5. **run() 返回契约**：`{ code, out, err }`，out/err 非空时以单个 `\n` 结尾，可直接写流；主入口按 §4.5 原样实现（`require.main === module` 守卫 + stdout/stderr 写入 + `process.exit(code)`）。测试通过注入 `cwd` / `env` / `now` 完成，未用 child_process。
6. **工单号生成**（§5-4）：`seq[formatDateKey(now)] = (旧值||0)+1`，`WO-<YYYYMMDD>-<padStart(2)>`，序号 >99 自然扩位；跨日键不同自然归 01（AC-2，测试注入次日 now 验证）。
7. **进度不封顶（裁决 1）**：`Math.round(ok/plan*100)`，单笔超额即已完成（`>=` 判定），列表/详情如实显示 >100%（自测中验证到 200%）。
8. **"非空"判定口径**：产品名称与操作工按 `trim() !== ''` 判空（纯空白视为空），存储保留用户原始输入；日期仅校验 `^\d{4}-\d{2}-\d{2}$` + 真实日历日（Date.UTC 反解），不做过去/未来限制（裁决 2）。
9. **query 的日期校验**：无效日期按错误处理、退出码 1（§8 开放问题 1 的既定裁决），错误文案与 report 的日期错误一致。

## 3. 偏离设计的点及原因

无实质性偏离。以下为设计留白处的取舍（均不影响任何 AC 判定，供测试/验收知悉）：

1. **只读命令（list/detail/query）不调用 save**：设计 §4.5 流程图泛写为"…→ save → 组装 out/err"，但纯读命令在空数据状态下若照写会把空数据落盘、凭空创建默认 `data.json`，与 AC-14"默认 data.json 不被创建"及 AC-15"不伪造数据"的意图相悖。故仅 create/report（有内存变更）在全部校验通过后 save；只读命令失败/成功均不触碰磁盘。
2. **detail 对"工单存在但 0 条记录"的输出**：§4.1 同时要求"首行同 list 行格式"与"query/detail 无记录输出（无报工记录）"，实现为**聚合行 + `（无报工记录）`** 两行同时输出，两句要求均满足。
3. **数据文件读取阶段异常**（非 JSON 解析错误，如文件被锁/无权限）一并按"损坏"处理，避免未处理异常破坏 FR-9 纯文本输出契约；正常损坏场景（解析失败/结构不符）行为与设计完全一致。

## 4. 自测结果（实际执行）

**环境**：Windows，Node v24.16.0（`node --version` 实测输出）。

**① 全量单元/端到端测试**（工作区根目录实际执行）：

```
命令：node --test
结果：exit code 0
输出摘要（TAP 尾部实测）：
  ℹ tests 41
  ℹ suites 0
  ℹ pass 41
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 109.6169
```

41 个测试全部通过、0 失败，覆盖：logic 纯函数 14 个用例（含 2026-02-30、abc、-1、1.5、闰年、跨日、超额、稳定排序、AND 筛选）、store 7 个用例（缺失/正常/JSON 损坏/10 种结构损坏且不写回/AC-13/AC-14 路径解析）、CLI 端到端 20 个用例（AC-1~AC-15 逐条 + 用法错误 15 种 argv + 损坏文件不覆盖 + 设计留白行为）。

**② 真实进程冒烟**（`node workorder.js …` 实际执行，`WORKORDER_DATA_FILE` 指向临时目录，17 步全部退出码符合预期）：

- `create 支架 100` / `create 轴承 50` → exit 0，`已创建：WO-20261112-01`、`WO-20261112-02`（当日序号递增）
- `report … 张三 30 2` / `report … 李四 40 1` → exit 0，`报工成功：…（累计合格 70，累计不良 3，状态：进行中）`
- `list` → 表头 + 两行聚合，格式 `工单号 | 产品 | 计划 | 累计合格 | 累计不良 | 进度 | 状态`
- `detail` → 聚合行 + 按日期排序记录行；`query 2026-11-12` → 命中行；`query --worker 李四` / 空日 → `（无报工记录）` exit 0
- 拒绝分支：日期 `2026-02-30`、0/0、不存在工单、已完工后再报 → 均 exit 1 且文案可区分；单笔超额 130 → exit 0，累计 200、`list` 显示 `200%`、状态已完成（裁决 1）
- 用法错误（无命令）→ exit 1；`WORKORDER_DATA_FILE` 指向的临时文件已生成，工作区根目录默认 `data.json` 确认未被创建（`Test-Path` = False）

冒烟临时文件已清理，工作区仅保留设计 §3 规定的 4 个源码/配置文件 + `test/` 3 个测试文件。

## 5. DEV-QUESTION 清单

无。本次未遇到阻塞实现的设计缺陷；设计 §8 三个开放问题均已按文档既定口径落实（query 无效日期按错误处理、空结果文案与 ` | ` 分隔符按 §4.1 原文、create/report 位置参数）。

---

# 修复轮 1

> 输入：docs/workorder/04-test-report.md（BUG 清单）+ 02-design.md。仅修复指派的 BUG-1，不改产品其他行为、不重构范围外代码、不扩需求；未执行任何 git 操作，未安装依赖，未改动任何测试文件。

## 1. 本次修复的 BUG 清单

| BUG | 严重度 | 状态 | 修复位置 |
|---|---|---|---|
| BUG-1（`WORKORDER_DATA_FILE` 指向不存在目录时 create/report 抛未捕获 ENOENT 英文堆栈，违反 FR-9） | minor | 已修复 | workorder.js（`saveOr` 保护 + doCreate/doReport 接入） |

## 2. 关键实现决定

1. **修复层级选在 `run()` 编排层而非 `store.save` 内部**（测试报告建议归属给出的两个方案之二）：`store.js` 完全未改动，保持设计 §4.3 的 `save(filePath, data)` 原样签名（直接 `writeFileSync`，异常向上抛）；在 workorder.js 新增 `saveOr(data, filePath)`，内部 try/catch 包裹 `save`，成功返回 `null`、失败返回 `fail()` 结果。理由：用户可见的错误文案与退出码属 CLI 编排职责（§4.1），store 层无 return 契约，改 store 签名反而牵连既有 store 测试与 §4.3 契约。
2. **两个写盘调用点统一接入**：doCreate 与 doReport 中原 `save(filePath, data)` 改为 `const saveFailed = saveOr(data, filePath); if (saveFailed) return saveFailed;`。workorder.js 中仅此两处写盘（只读命令本就不落盘，03-dev-notes §3-1），故写盘异常路径已全覆盖。
3. **错误文案**：`错误：数据文件写入失败：<路径>（请确认目录存在且可写后重试）`——一行中文、`错误：` 前缀、写明原因与人工处理指引，与 §4.1 既有文案风格（含路径 + 括号内指引）一致且可区分；退出码 1，`out` 为空。目录不存在（ENOENT）、无写权限（EACCES）等所有写盘异常均落入此文案，不在文案中混入英文堆栈。
4. **"拒绝即无数据变更"保持成立**：save 失败时内存变更（seq 递增 / order.push / reports.push）不会落盘，磁盘字节不变；下次 run 重新 `load` 推导，无残留（真实进程冒烟已验证：create 写盘失败后 report 报"工单不存在"）。

## 3. 偏离设计的点及原因

无范围外偏离。设计 §4.1 错误文案表未列"写盘失败"条目（FR-9 仅约定输出形态），新增该文案属 FR-9 要求下的必要补充，措辞沿用 §4.1 既有风格；如需纳入 §4.1 文案表请架构师在 02-design 补录。

## 4. 自测结果（实际执行）

**环境**：Windows，Node v24.16.0。

**① 全量测试**（工作区根目录实际执行 `node --test`）：

```
结果：exit code 0
输出摘要（TAP 尾部实测）：
  ℹ tests 79
  ℹ suites 0
  ℹ pass 79
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
```

79 = 既有 41 + 验收 38 全部通过；原 BUG-1 失败用例 `AC-14 异常：WORKORDER_DATA_FILE 指向不存在目录时应给出明确中文错误，而非未捕获异常（BUG-1 证据）` 已转绿（`node --test` 输出中该用例行实测 `✔`）。测试文件零改动，既有断言未削弱。

**② 真实进程复现冒烟**（按测试报告 BUG-1 复现步骤，`WORKORDER_DATA_FILE` 指向不存在目录 `no-such-sub\p.json`）：

- `node workorder.js create 支架 100` → exit 1，stderr 单行 `错误：数据文件写入失败：<路径>（请确认目录存在且可写后重试）`，无英文堆栈
- `node workorder.js report WO-20261112-01 …` → exit 1，`错误：工单不存在：WO-20261112-01`（证明写盘失败后磁盘无任何变更）

冒烟临时目录已清理。

## 5. DEV-QUESTION 清单

无阻塞项。仅一条记录级提示（见 §3）：写盘失败文案为新补充的用户可见文案，建议架构师将其补入 02-design §4.1 错误文案表以保持文档与实现一致。
