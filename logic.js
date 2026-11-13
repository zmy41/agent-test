'use strict';

/**
 * logic.js —— 纯领域逻辑（无 I/O，设计 §4.4）
 * 状态与累计数一律由 reports 推导，不落盘（设计 §1 / §4.2）。
 */

const STATUS = { PENDING: '待开工', DOING: '进行中', DONE: '已完成' };

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;
const QTY_STR_RE = /^-?\d+$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Date -> 'YYYYMMDD'（本地时区） */
function formatDateKey(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

/**
 * true 仅当 ^\d{4}-\d{2}-\d{2}$ 且为真实日历日（Date.UTC 反解校验月/日，2026-02-30 → false）。
 * 不做过去/未来限制（裁决 2）。
 */
function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_STR_RE.test(s)) return false;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

/** -> { kind:'ok', value:int } | { kind:'neg' }（^-?\d+$ 且 <0）| { kind:'nonInt' }（非整数格式） */
function parseQty(s) {
  if (typeof s !== 'string' || !QTY_STR_RE.test(s)) return { kind: 'nonInt' };
  const value = Number(s);
  if (value < 0) return { kind: 'neg' };
  return { kind: 'ok', value };
}

/** -> { ok:true, product, planQty } | { ok:false, message }（名称非空；计划数量为正整数） */
function validateCreate(name, planStr) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, message: '错误：产品名称不能为空' };
  }
  const qty = parseQty(planStr);
  if (qty.kind !== 'ok' || qty.value <= 0) {
    return { ok: false, message: `错误：计划数量必须为正整数：${planStr}` };
  }
  return { ok: true, product: name, planQty: qty.value };
}

/** -> 'WO-<dateKey>-<NN>'；序号 >99 时 padStart(2) 自然扩位（如 -100） */
function generateOrderId(dateKey, seqN) {
  return `WO-${dateKey}-${pad2(seqN)}`;
}

/** -> { id, product, planQty, reports: [] } */
function makeOrder(id, product, planQty) {
  return { id, product, planQty, reports: [] };
}

/** 按 id 精确匹配 -> order | undefined */
function findOrder(data, id) {
  return data.orders.find((order) => order.id === id);
}

/** -> { okQty, badQty }（Σ reports） */
function totals(order) {
  let okQty = 0;
  let badQty = 0;
  for (const report of order.reports) {
    okQty += report.okQty;
    badQty += report.badQty;
  }
  return { okQty, badQty };
}

/** reports.length===0 → 待开工；ΣokQty >= planQty → 已完成（可超计划，裁决 1）；否则进行中 */
function computeStatus(order) {
  if (order.reports.length === 0) return STATUS.PENDING;
  const { okQty } = totals(order);
  return okQty >= order.planQty ? STATUS.DONE : STATUS.DOING;
}

/** -> 新数组：按 date 字符串升序稳定排序，同日保持原数组（录入）顺序；不修改入参 */
function sortDetailReports(reports) {
  return reports
    .map((report, index) => ({ report, index }))
    .sort((a, b) => {
      if (a.report.date !== b.report.date) return a.report.date < b.report.date ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.report);
}

/**
 * 按日查询（AC-10/11）：遍历 orders×reports，
 * date 相等 &&（有 wo 则 id 相等）&&（有 worker 则 worker 相等）
 * -> [{ orderId, date, worker, okQty, badQty }]，按工单创建顺序、同工单按录入先后。
 */
function queryReports(data, dateStr, filter) {
  const f = filter || {};
  const rows = [];
  for (const order of data.orders) {
    if (f.wo && order.id !== f.wo) continue;
    for (const report of order.reports) {
      if (report.date !== dateStr) continue;
      if (f.worker && report.worker !== f.worker) continue;
      rows.push({
        orderId: order.id,
        date: report.date,
        worker: report.worker,
        okQty: report.okQty,
        badQty: report.badQty,
      });
    }
  }
  return rows;
}

// ---------- 本期新增：按月统计与 CSV 导出（docs/workorder-monthly-csv/02-design.md §4.2，纯函数无 I/O） ----------

const YM_STR_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CSV_HEADER = '日期,工单号,操作工,合格数量,不良数量';

/**
 * true 仅当 ^\d{4}-(0[1-9]|1[0-2])$（Q-2：年月必填）。
 * 不校验年份范围（0000-9999 均接受），无过去/未来限制（沿用"日期不做业务限制"口径）。
 */
function isValidYearMonthStr(s) {
  return typeof s === 'string' && YM_STR_RE.test(s);
}

/**
 * 按月查询（Q-1/Q-5）：遍历 orders（创建顺序）× reports（录入顺序），
 * 取 report.date.slice(0, 7) === yearMonth 的记录（月份隔离，AC-5，纯前缀比较），
 * -> [{ orderId, date, worker, okQty, badQty }]，按 date 升序稳定排序
 * （比较器仅比 date；稳定排序保证同日保持遍历顺序，等价既有 detail/query 口径）。
 * yearMonth 须已通过 isValidYearMonthStr（调用方先校验）；不修改入参，返回新数组。
 */
function queryMonthReports(data, yearMonth) {
  const rows = [];
  for (const order of data.orders) {
    for (const report of order.reports) {
      if (report.date.slice(0, 7) !== yearMonth) continue;
      rows.push({
        orderId: order.id,
        date: report.date,
        worker: report.worker,
        okQty: report.okQty,
        badQty: report.badQty,
      });
    }
  }
  return rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return 0; // 同日：Array.sort 稳定排序保持遍历（录入）顺序
  });
}

/** -> { count: rows.length, okQty: Σ okQty, badQty: Σ badQty }（实际值直加，不封顶不剔除） */
function summarizeMonth(rows) {
  let okQty = 0;
  let badQty = 0;
  for (const row of rows) {
    okQty += row.okQty;
    badQty += row.badQty;
  }
  return { count: rows.length, okQty, badQty };
}

/** RFC 4180 式转义：String(field) 后含逗号/双引号/\r/\n 之一 → 引号包裹且内部双引号双写；否则原样 */
function csvEscape(field) {
  const s = String(field);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * -> CSV 文本：表头常量 + rows 每行 [date, orderId, worker, okQty, badQty] 逐字段转义，
 * 行间 '\n' 连接，整个字符串以恰一个 '\n' 结尾；rows 为空时仅表头行（Q-5）。
 */
function toCsv(rows) {
  const lines = [CSV_HEADER];
  for (const row of rows) {
    lines.push([row.date, row.orderId, row.worker, row.okQty, row.badQty].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  STATUS,
  formatDateKey,
  isValidDateStr,
  parseQty,
  validateCreate,
  generateOrderId,
  makeOrder,
  findOrder,
  totals,
  computeStatus,
  sortDetailReports,
  queryReports,
  isValidYearMonthStr,
  queryMonthReports,
  summarizeMonth,
  csvEscape,
  toCsv,
};
