# 任务需求：给工单报工 CLI 增加按月统计与 CSV 导出功能

> 来源：GitHub issue zmy41/agent-test#5（需求方经对话框提交，2026-11-13）。

## 需求原文

给工单报工CLI增加按月统计与CSV导出功能

## 约束（需求方既定）

- Node.js 零第三方依赖；测试用 node:test（`node --test` 执行）
- 宿主为 Windows，shell 可用 bash 或 pwsh
- 最小可用规模，不引入框架、不做过度设计

## 现有系统（只读参考；按需自行读取，勿修改）

- 现有产品定义：`docs/workorder/01-prd.md`（FR-1~FR-9、AC-1~AC-15；其"非目标"第 4 条原将"统计报表、导出（CSV/Excel）"列为暂不做，本期转为本任务范围）
- 技术设计：`docs/workorder/02-design.md`；现有命令形态以 `workorder.js` 为准（子命令 create|report|list|detail|query，query 支持 --wo/--worker）
- 领域逻辑：`logic.js`；数据文件 I/O：`store.js`（运行目录 `data.json`，环境变量 `WORKORDER_DATA_FILE` 可覆盖路径）
- 输出风格：纯文本、中文提示、错误退出码非 0

## 本环节要求（调度者补充）

- PRD 只覆盖新增的"按月统计"与"CSV 导出"两个功能域；现有功能不重新定义，如有交互/边界需在开放问题中列出。
- FR-x / AC-x 编号在本目录从 1 重新开始，编号贯穿后续环节（TASK-x / BUG-x / DEV-QUESTION-x）。
