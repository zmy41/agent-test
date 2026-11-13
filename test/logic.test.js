'use strict';

/** logic.js 单元测试（设计 TASK-2 / TASK-4，覆盖 AC-2/3/5/7/8/9/10/11 相关纯函数行为） */

const test = require('node:test');
const assert = require('node:assert/strict');

const logic = require('../logic');

test('STATUS 状态词表唯一：待开工/进行中/已完成', () => {
  assert.deepEqual(logic.STATUS, { PENDING: '待开工', DOING: '进行中', DONE: '已完成' });
});

test('formatDateKey：Date -> YYYYMMDD（本地时区）', () => {
  assert.equal(logic.formatDateKey(new Date(2026, 10, 12)), '20261112');
  assert.equal(logic.formatDateKey(new Date(2026, 0, 1)), '20260101');
  assert.equal(logic.formatDateKey(new Date(2026, 11, 31, 23, 59, 59)), '20261231');
});

test('isValidDateStr：格式 + 真实日历日校验（2026-02-30 → false）', () => {
  assert.equal(logic.isValidDateStr('2026-11-12'), true);
  assert.equal(logic.isValidDateStr('2024-02-29'), true); // 闰年成立
  assert.equal(logic.isValidDateStr('2026-02-30'), false); // 不存在的日期
  assert.equal(logic.isValidDateStr('2026-02-29'), false); // 平年无 2/29
  assert.equal(logic.isValidDateStr('2026-13-01'), false);
  assert.equal(logic.isValidDateStr('2026-00-10'), false);
  assert.equal(logic.isValidDateStr('2026-11-00'), false);
  assert.equal(logic.isValidDateStr('2026-11-31'), false); // 11 月无 31 日
  assert.equal(logic.isValidDateStr('2026-2-3'), false); // 格式不合规
  assert.equal(logic.isValidDateStr('20261112'), false);
  assert.equal(logic.isValidDateStr('2026/11/12'), false);
  assert.equal(logic.isValidDateStr('2026-11-12 '), false);
  assert.equal(logic.isValidDateStr('abc'), false);
  assert.equal(logic.isValidDateStr(''), false);
});

test('isValidDateStr：允许补录过去 / 预录未来（裁决 2）', () => {
  assert.equal(logic.isValidDateStr('1999-01-01'), true);
  assert.equal(logic.isValidDateStr('2999-12-31'), true);
});

test('parseQty：ok / neg / nonInt 三类（覆盖 abc、-1、1.5 等）', () => {
  assert.deepEqual(logic.parseQty('0'), { kind: 'ok', value: 0 });
  assert.deepEqual(logic.parseQty('5'), { kind: 'ok', value: 5 });
  assert.deepEqual(logic.parseQty('120'), { kind: 'ok', value: 120 });
  assert.deepEqual(logic.parseQty('007'), { kind: 'ok', value: 7 });
  assert.equal(logic.parseQty('-1').kind, 'neg');
  assert.equal(logic.parseQty('-120').kind, 'neg');
  assert.equal(logic.parseQty('1.5').kind, 'nonInt');
  assert.equal(logic.parseQty('abc').kind, 'nonInt');
  assert.equal(logic.parseQty('').kind, 'nonInt');
  assert.equal(logic.parseQty(' 5').kind, 'nonInt');
  assert.equal(logic.parseQty('5 ').kind, 'nonInt');
  assert.equal(logic.parseQty('+5').kind, 'nonInt');
  assert.equal(logic.parseQty('1e2').kind, 'nonInt');
  assert.equal(logic.parseQty('--1').kind, 'nonInt');
});

test('validateCreate：名称非空 + 计划数量为正整数（0/-5/2.5/abc 均拒绝）', () => {
  assert.deepEqual(logic.validateCreate('支架', '100'), { ok: true, product: '支架', planQty: 100 });
  assert.deepEqual(logic.validateCreate('支架', '001'), { ok: true, product: '支架', planQty: 1 });
  assert.equal(logic.validateCreate('', '100').ok, false);
  assert.equal(logic.validateCreate('', '100').message, '错误：产品名称不能为空');
  assert.equal(logic.validateCreate('   ', '100').message, '错误：产品名称不能为空');
  assert.equal(logic.validateCreate('支架', '0').message, '错误：计划数量必须为正整数：0');
  assert.equal(logic.validateCreate('支架', '-5').message, '错误：计划数量必须为正整数：-5');
  assert.equal(logic.validateCreate('支架', '2.5').message, '错误：计划数量必须为正整数：2.5');
  assert.equal(logic.validateCreate('支架', 'abc').message, '错误：计划数量必须为正整数：abc');
  assert.equal(logic.validateCreate('支架', '').message, '错误：计划数量必须为正整数：');
});

test('generateOrderId：WO-<dateKey>-<NN>，序号 >99 自然扩位', () => {
  assert.equal(logic.generateOrderId('20261112', 1), 'WO-20261112-01');
  assert.equal(logic.generateOrderId('20261112', 9), 'WO-20261112-09');
  assert.equal(logic.generateOrderId('20261112', 10), 'WO-20261112-10');
  assert.equal(logic.generateOrderId('20261112', 100), 'WO-20261112-100');
});

test('makeOrder：初始结构', () => {
  assert.deepEqual(logic.makeOrder('WO-20261112-01', '支架', 100), {
    id: 'WO-20261112-01',
    product: '支架',
    planQty: 100,
    reports: [],
  });
});

test('findOrder：按 id 精确匹配，未命中 undefined', () => {
  const data = {
    orders: [logic.makeOrder('WO-20261112-01', 'A', 10), logic.makeOrder('WO-20261112-02', 'B', 20)],
  };
  assert.equal(logic.findOrder(data, 'WO-20261112-02').product, 'B');
  assert.equal(logic.findOrder(data, 'WO-20261112-03'), undefined);
  assert.equal(logic.findOrder(data, 'WO-20261112-1'), undefined);
});

function orderWith(planQty, reports) {
  const order = logic.makeOrder('WO-20261112-01', 'X', planQty);
  order.reports.push(...reports);
  return order;
}

test('totals：累计合格/不良汇总，空记录为 0/0', () => {
  assert.deepEqual(logic.totals(orderWith(100, [])), { okQty: 0, badQty: 0 });
  assert.deepEqual(
    logic.totals(
      orderWith(100, [
        { date: '2026-11-12', worker: '张三', okQty: 30, badQty: 2 },
        { date: '2026-11-13', worker: '李四', okQty: 40, badQty: 1 },
      ])
    ),
    { okQty: 70, badQty: 3 }
  );
});

test('computeStatus：待开工/进行中/已完成，含单笔超额（裁决 1）', () => {
  assert.equal(logic.computeStatus(orderWith(100, [])), '待开工');
  assert.equal(
    logic.computeStatus(orderWith(100, [{ date: '2026-11-12', worker: '张三', okQty: 30, badQty: 2 }])),
    '进行中'
  );
  assert.equal(
    logic.computeStatus(orderWith(100, [{ date: '2026-11-12', worker: '张三', okQty: 100, badQty: 0 }])),
    '已完成'
  );
  assert.equal(
    logic.computeStatus(orderWith(100, [{ date: '2026-11-12', worker: '张三', okQty: 120, badQty: 0 }])),
    '已完成'
  );
  assert.equal(
    logic.computeStatus(orderWith(10, [{ date: '2026-11-12', worker: '张三', okQty: 10, badQty: 0 }])),
    '已完成'
  ); // 待开工一笔直达已完成
});

test('sortDetailReports：日期升序稳定排序，同日保持录入顺序，原数组不变（AC-5）', () => {
  const d1z = { date: '2026-11-12', worker: '张三', okQty: 30, badQty: 2 };
  const d2l = { date: '2026-11-13', worker: '李四', okQty: 40, badQty: 1 };
  const d1w = { date: '2026-11-12', worker: '王五', okQty: 5, badQty: 0 };
  const reports = [d1z, d2l, d1w];
  assert.deepEqual(logic.sortDetailReports(reports), [d1z, d1w, d2l]);
  assert.deepEqual(reports, [d1z, d2l, d1w]); // 原数组不变
  const sameDay = [
    { date: '2026-11-12', worker: 'a', okQty: 1, badQty: 0 },
    { date: '2026-11-12', worker: 'b', okQty: 2, badQty: 0 },
  ];
  assert.deepEqual(
    logic.sortDetailReports(sameDay).map((r) => r.worker),
    ['a', 'b']
  );
});

function demoData() {
  return {
    orders: [
      {
        id: 'WO-20261112-01',
        product: 'A',
        planQty: 100,
        reports: [
          { date: '2026-11-12', worker: '张三', okQty: 30, badQty: 2 },
          { date: '2026-11-13', worker: '李四', okQty: 40, badQty: 1 },
        ],
      },
      {
        id: 'WO-20261112-02',
        product: 'B',
        planQty: 50,
        reports: [{ date: '2026-11-12', worker: '李四', okQty: 10, badQty: 0 }],
      },
    ],
    seq: { '20261112': 2 },
  };
}

test('queryReports：按日跨工单，按工单创建顺序输出（AC-10）', () => {
  assert.deepEqual(logic.queryReports(demoData(), '2026-11-12', {}), [
    { orderId: 'WO-20261112-01', date: '2026-11-12', worker: '张三', okQty: 30, badQty: 2 },
    { orderId: 'WO-20261112-02', date: '2026-11-12', worker: '李四', okQty: 10, badQty: 0 },
  ]);
  assert.deepEqual(logic.queryReports(demoData(), '2026-11-14', {}), []);
});

test('queryReports：工单号/操作工/组合 AND 筛选（AC-11）', () => {
  const data = demoData();
  assert.deepEqual(
    logic.queryReports(data, '2026-11-12', { wo: 'WO-20261112-01' }).map((r) => r.worker),
    ['张三']
  );
  assert.deepEqual(
    logic.queryReports(data, '2026-11-12', { worker: '李四' }).map((r) => r.orderId),
    ['WO-20261112-02']
  );
  assert.deepEqual(logic.queryReports(data, '2026-11-12', { wo: 'WO-20261112-01', worker: '李四' }), []);
  assert.deepEqual(
    logic.queryReports(data, '2026-11-13', { wo: 'WO-20261112-01' }).map((r) => r.worker),
    ['李四']
  );
  assert.deepEqual(logic.queryReports(data, '2026-11-13', { wo: 'WO-20261112-02' }), []);
});

// ---------- 本期新增：按月统计与 CSV 导出纯函数（docs/workorder-monthly-csv TASK-1/TASK-2） ----------

test('isValidYearMonthStr：^\\d{4}-(0[1-9]|1[0-2])$，年份不限、月份 01-12（AC-4 纯函数层）', () => {
  assert.equal(logic.isValidYearMonthStr('2026-11'), true);
  assert.equal(logic.isValidYearMonthStr('2026-01'), true);
  assert.equal(logic.isValidYearMonthStr('2026-12'), true);
  assert.equal(logic.isValidYearMonthStr('0000-01'), true); // 年份不限范围
  assert.equal(logic.isValidYearMonthStr('9999-12'), true);
  assert.equal(logic.isValidYearMonthStr('2026-13'), false);
  assert.equal(logic.isValidYearMonthStr('2026-00'), false);
  assert.equal(logic.isValidYearMonthStr('2026-1'), false); // 缺位
  assert.equal(logic.isValidYearMonthStr('202601'), false); // 无连字符
  assert.equal(logic.isValidYearMonthStr('2026-011'), false);
  assert.equal(logic.isValidYearMonthStr('abcd-01'), false); // 年份须为数字
  assert.equal(logic.isValidYearMonthStr('2026/11'), false);
  assert.equal(logic.isValidYearMonthStr('2026-11 '), false); // 尾随空格
  assert.equal(logic.isValidYearMonthStr(' 2026-11'), false);
  assert.equal(logic.isValidYearMonthStr('abc'), false);
  assert.equal(logic.isValidYearMonthStr(''), false);
  assert.equal(logic.isValidYearMonthStr(null), false);
  assert.equal(logic.isValidYearMonthStr(undefined), false);
  assert.equal(logic.isValidYearMonthStr(202611), false); // 非字符串一律 false
});

/** 月度场景数据：两工单、三个月份穿插，含同日多笔 */
function monthData() {
  return {
    orders: [
      {
        id: 'WO-20261112-01',
        product: 'A',
        planQty: 100,
        reports: [
          { date: '2026-11-12', worker: '张三', okQty: 30, badQty: 2 },
          { date: '2026-12-01', worker: '李四', okQty: 40, badQty: 1 }, // 另一月份
          { date: '2026-11-12', worker: '王五', okQty: 5, badQty: 0 }, // 同日后录
        ],
      },
      {
        id: 'WO-20261112-02',
        product: 'B',
        planQty: 50,
        reports: [{ date: '2026-11-13', worker: '赵六', okQty: 10, badQty: 0 }],
      },
    ],
    seq: { '20261112': 2 },
  };
}

test('queryMonthReports：月份隔离互不混入（AC-5）', () => {
  const data = monthData();
  const nov = logic.queryMonthReports(data, '2026-11');
  assert.deepEqual(
    nov.map((r) => [r.date, r.worker]),
    [['2026-11-12', '张三'], ['2026-11-12', '王五'], ['2026-11-13', '赵六']]
  );
  const dec = logic.queryMonthReports(data, '2026-12');
  assert.deepEqual(
    dec.map((r) => [r.date, r.worker, r.orderId]),
    [['2026-12-01', '李四', 'WO-20261112-01']]
  );
  assert.deepEqual(logic.queryMonthReports(data, '2025-11'), []); // 无记录月份 -> 空数组
  assert.deepEqual(logic.queryMonthReports(data, '2026-1'), []); // 非同年月前缀不误命中
});

test('queryMonthReports：跨工单归集 + 行序=日期升序稳定（同日跨工单按创建顺序）（AC-2）', () => {
  // 晚创建工单反而有更早日期的报工：排序后应按日期升序，而非工单创建顺序
  const data = {
    orders: [
      {
        id: 'WO-20261112-01',
        product: 'A',
        planQty: 10,
        reports: [{ date: '2026-11-13', worker: '先创建晚日期', okQty: 1, badQty: 0 }],
      },
      {
        id: 'WO-20261112-02',
        product: 'B',
        planQty: 10,
        reports: [{ date: '2026-11-12', worker: '后创建早日期', okQty: 2, badQty: 0 }],
      },
    ],
    seq: {},
  };
  assert.deepEqual(
    logic.queryMonthReports(data, '2026-11').map((r) => [r.orderId, r.worker, r.date]),
    [
      ['WO-20261112-02', '后创建早日期', '2026-11-12'],
      ['WO-20261112-01', '先创建晚日期', '2026-11-13'],
    ]
  );
});

test('queryMonthReports：同日多笔保持遍历（录入）顺序；不修改入参', () => {
  const data = monthData();
  const before = JSON.parse(JSON.stringify(data));
  const rows = logic.queryMonthReports(data, '2026-11');
  assert.deepEqual(data, before); // 入参未被修改
  // 2026-11-12 两笔均属工单 1，按录入先后：张三 -> 王五
  assert.deepEqual(
    rows.filter((r) => r.date === '2026-11-12').map((r) => r.worker),
    ['张三', '王五']
  );
  // 每行仅含五个约定字段
  assert.deepEqual(Object.keys(rows[0]).sort(), ['badQty', 'date', 'okQty', 'orderId', 'worker']);
});

test('queryMonthReports：对抗性——手改脏日期按纯前缀比较（设计 §8 风险4，不额外校验）', () => {
  const data = {
    orders: [
      {
        id: 'WO-20261112-01',
        product: 'A',
        planQty: 10,
        reports: [
          { date: '2026-11-99', worker: '甲', okQty: 1, badQty: 0 }, // 非真实日历日，前缀命中
          { date: '20261112', worker: '乙', okQty: 1, badQty: 0 }, // 无连字符，前缀不命中
          { date: '2026-1-15', worker: '丙', okQty: 1, badQty: 0 }, // 缺位日期，前缀不命中
        ],
      },
    ],
    seq: {},
  };
  assert.deepEqual(
    logic.queryMonthReports(data, '2026-11').map((r) => r.worker),
    ['甲']
  );
});

test('summarizeMonth：直加汇总、空行为 0/0/0、超额不封顶（FR-1）', () => {
  assert.deepEqual(logic.summarizeMonth([]), { count: 0, okQty: 0, badQty: 0 });
  assert.deepEqual(
    logic.summarizeMonth([
      { orderId: 'O1', date: '2026-11-12', worker: '张三', okQty: 30, badQty: 2 },
      { orderId: 'O1', date: '2026-11-13', worker: '李四', okQty: 40, badQty: 1 },
    ]),
    { count: 2, okQty: 70, badQty: 3 }
  );
  // 单笔超额报工不封顶：120 直接入总
  assert.deepEqual(
    logic.summarizeMonth([{ orderId: 'O1', date: '2026-11-12', worker: '张三', okQty: 120, badQty: 0 }]),
    { count: 1, okQty: 120, badQty: 0 }
  );
});

test('csvEscape：普通字段原样；逗号/双引号/\\r/\\n 触发引号包裹+双写（AC-7 纯函数层）', () => {
  assert.equal(logic.csvEscape('张三'), '张三');
  assert.equal(logic.csvEscape(''), '');
  assert.equal(logic.csvEscape(30), '30'); // 数量字段为数字，String() 后原样
  assert.equal(logic.csvEscape('a,b'), '"a,b"');
  assert.equal(logic.csvEscape('a"b'), '"a""b"');
  assert.equal(logic.csvEscape('"'), '""""');
  assert.equal(logic.csvEscape('a\nb'), '"a\nb"');
  assert.equal(logic.csvEscape('a\rb'), '"a\rb"');
  assert.equal(logic.csvEscape('a,b"c\nd'), '"a,b""c\nd"'); // 组合命中仅包裹一次
  assert.equal(logic.csvEscape('中文、全角逗号，不转义'), '中文、全角逗号，不转义'); // 全角标点非 CSV 特殊字符
});

/** 极简 RFC 4180 解析器（仅测试回验用）：整段 CSV 文本 -> 二维字符串数组 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else if (ch === '\r') {
      i += 1; // 防御性忽略 \r（本系统行分隔为 \n）
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test('toCsv：表头五列固定、字段顺序 date,orderId,worker,okQty,badQty、末尾恰一个换行（AC-6 纯函数层）', () => {
  assert.equal(logic.toCsv([]), '日期,工单号,操作工,合格数量,不良数量\n'); // 空 rows 仅表头（Q-5）
  const csv = logic.toCsv([
    { orderId: 'WO-20261112-01', date: '2026-11-12', worker: '张三', okQty: 30, badQty: 2 },
    { orderId: 'WO-20261112-02', date: '2026-11-13', worker: '王五', okQty: 5, badQty: 0 },
  ]);
  assert.equal(
    csv,
    '日期,工单号,操作工,合格数量,不良数量\n' +
      '2026-11-12,WO-20261112-01,张三,30,2\n' +
      '2026-11-13,WO-20261112-02,王五,5,0\n'
  );
  assert.ok(csv.endsWith('\n'));
  assert.ok(!csv.endsWith('\n\n')); // 末尾恰一个换行
  assert.ok(!csv.includes('\n\n')); // 无空行
});

test('toCsv：含逗号/双引号/换行字段转义后解析回验，列数与原值不变（AC-7）', () => {
  const rows = [
    { orderId: 'WO-20261112-01', date: '2026-11-12', worker: '张三,李四', okQty: 10, badQty: 0 },
    { orderId: 'WO-20261112-01', date: '2026-11-12', worker: '王"五"', okQty: 5, badQty: 0 },
    { orderId: 'WO-20261112-02', date: '2026-11-13', worker: '多\n行', okQty: 1, badQty: 2 },
  ];
  const csv = logic.toCsv(rows);
  const parsed = parseCsv(csv);
  assert.equal(parsed.length, 4); // 表头 + 3 数据行（含换行字段不串行）
  assert.deepEqual(parsed[0], ['日期', '工单号', '操作工', '合格数量', '不良数量']);
  assert.deepEqual(
    parsed.slice(1).map((r) => r[2]),
    ['张三,李四', '王"五"', '多\n行']
  );
  for (const line of parsed) assert.equal(line.length, 5); // 每行恰 5 列，无串列
});
