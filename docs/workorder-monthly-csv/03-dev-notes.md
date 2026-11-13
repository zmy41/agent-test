# 工单报工 CLI — 按月统计与 CSV 导出 开发记录（03-dev-notes）

> 角色产出：开发。输入：docs/workorder-monthly-csv/02-design.md + 调度者三项裁决。
> 执行范围：TASK-1 ~ TASK-5 全部内容；不改动 store.js、不改既有命令行为与既有输出；无 git 提交。

## 1. 本次完成的 TASK 清单

| TASK | 内容 | 落点 |
|---|---|---|
| TASK-1 | logic.js 月度纯函数 `isValidYearMonthStr` / `queryMonthReports` / `summarizeMonth` + 单元测试（非法年月边界、AC-5 月份隔离、AC-2 跨工单、同日跨工单行序、入参不可变、脏日期对抗） | logic.js、test/logic.test.js（追加 9 例） |
| TASK-2 | logic.js CSV 纯函数 `csvEscape` / `toCsv` + 单元测试（空 rows 仅表头、逗号/双引号/\r/\n 转义、末尾恰一个换行、RFC 4180 解析回验） | logic.js、test/logic.test.js（含极简解析器，仅测试用） |
| TASK-3 | workorder.js 接入 `stat`：COMMAND_SPECS 增键、年月错误文案、`doStat`（空月提示 / 恰三行合计）、run 只读分支 + CLI 测试（AC-1~AC-5 命令级、缺省走既有用法错误旧文案、非法年月 stdout 空） | workorder.js、test/cli.test.js（追加 10 例） |
| TASK-4 | workorder.js 接入 `export`：`doExport`（`'\uFEFF'` 前缀、err 恒空、失败无残缺 CSV）+ CLI 测试（表头/行序/转义/空月/非法月/纯净性/BOM 存在/损坏文件） | workorder.js、test/cli.test.js |
| TASK-5 | 新增 test/acceptance-month-csv.test.js：AC-1~AC-12 端到端（含 AC-11 既有 query/list 回归抽查、AC-12 真实子进程与临时 .csv 双路 EF BB BF 字节级校验）；仓库根 `node --test` 收尾 | test/acceptance-month-csv.test.js（新文件，13 例） |

## 2. 关键实现决定

1. **五函数全部并入 logic.js**（无 csv.js、无新源码文件），均为纯函数无 I/O；既有 12 个导出与全部行为零改动，`module.exports` 仅追加 5 项。
2. **月归集**按 `report.date.slice(0, 7) === yearMonth` 纯字符串前缀比较（§8 风险 4：不做额外日期校验）；排序比较器仅比 date、相等返回 0，依赖 ES2019 起 `Array.prototype.sort` 稳定性保持同日录入顺序（与既有 `sortDetailReports` 行为等价）。
3. **BOM 在编排层**以字符串首字符 `'\uFEFF'` 拼接（`succeed('\uFEFF' + logic.toCsv(rows))`），经 stdout UTF-8 编码自然落为 EF BB BF 三字节，不操作字节流；`err` 恒为 `''`，失败路径不产生任何 stdout（无残缺 CSV）。
4. **stat/export 均不调用 saveOr**，为 run() switch 中的独立只读分支；数据文件不存在时走 store.load 的空数据启动 → 空月提示 / 仅表头（与 list/query 口径一致）。
5. **校验顺序按 §5-1 数据流**：parseArgs → resolveDataPath → load（损坏即错误）→ 年月校验（失败即返回，stdout 空）→ 纯推导 → 格式化。故损坏文件 + 非法年月时优先报损坏文案（已测试覆盖）。
6. **调度者三项裁决落实**：① USAGE_ERROR 旧文案一字未动（含缺省/多余位置参数、未知命令场景）；② 文案与命令名按 §4 原文实现（`（该月无报工记录）`、三行合计、`错误：年月无效，须为 YYYY-MM 且月份为 01-12：<输入>`、`stat`/`export`）；③ 未实现 `--out`，导出获取方式维持 stdout 重定向。

## 3. 偏离设计的点及原因

- 无功能性偏离。仅两处注释级差异：workorder.js 头部注释把 stat/export 列入只读命令清单；logic.js 新增段前加了一行来源标注注释。均不影响任何行为与输出。

## 4. 自测结果（命令 + 输出摘要）

宿主 Windows，全部经 pwsh 执行；导出取文件严格按 §5-3 用 `cmd /c "... > 文件.csv"`。

1. `node --test`（仓库根，全量 6 个测试文件）：**119 例，117 通过，2 失败**。失败均位于本次未改动的既有 test/acceptance-regression1.test.js（见 DEV-QUESTION-1）。
2. 本次新增/扩展三文件单独跑：`node --test test/logic.test.js test/cli.test.js test/acceptance-month-csv.test.js` → **65 例全部通过**（logic 27、cli 32、acceptance-month-csv 13 的合计口径，含对抗性用例：六类非法年月、损坏数据文件、脏日期前缀误命中、转义解析回验、只读不建文件/字节不变等）。
3. 失败归因实证（证明与本改动无关）：临时目录复制仓库并从 git HEAD 还原改动前 logic.js/workorder.js，运行同一文件 → **同样这 2 例失败**；另实测真实 CLI `create` 今日（2026-11-13）生成 `WO-20261113-01`，`detail WO-20261112-01` 报 `错误：工单不存在`，即用例硬编码工单号 + 真实时钟所致。
4. 真实进程端到端（临时目录 + cmd /c）：
   - `node workorder.js stat 2026-11` → `报工笔数：3 / 合格总数：75 / 不良总数：3`，退出码 0；空月 → `（该月无报工记录）` 退出码 0；`stat 2026-13` → 退出码 1、stderr `错误：年月无效，须为 YYYY-MM 且月份为 01-12：2026-13`、stdout 空。
   - `cmd /c "node workorder.js export 2026-11 > out.csv"` → 文件首三字节 **EF BB BF**，UTF-8 回读为表头 + 3 数据行（D1 张三 → D1 王五 → D2 李四，中文无乱码）。
   - `cmd /c "node workorder.js export 2026-13 > bad.csv"` → bad.csv **0 字节**（无残缺 CSV），stderr 一行中文错误，退出码 1。
   - 对照组（佐证风险 1）：同输出经 pwsh 7 `>` 重定向首三字节为 **FF FE**（UTF-16LE），确认必须用 cmd /c 取文件。
   - `node workorder.js stat`（缺省年月）→ 退出码 1、旧用法文案不变。

## 5. DEV-QUESTION 清单

- **DEV-QUESTION-1（非设计缺陷，测试资产缺陷上报，不阻塞本期验收）**：既有 test/acceptance-regression1.test.js 中 2 个真实进程用例（"BUG-1 修复（真实进程）：report 写盘失败路径…"、"AC-14 回归（真实进程）…"）先以真实系统时钟 `create`、再对硬编码 `WO-20261112-01` 报工/查详情，仅在 2026-11-12 当天可通过；今日（2026-11-13）起恒失败（create 实得 `WO-20261113-01`）。已用改动前 HEAD 代码复现同样失败，与本次 TASK-1~5 无关。影响：全量套件无法"全绿"展示；AC-11 的"既有套件全绿"判定需知悉此既有失败。按角色规则未修改测试角色产出的测试文件，请调度者转测试角色修复（如：从 create 输出解析工单号或注入固定日期）。其余既有 5 个测试文件全部通过。
