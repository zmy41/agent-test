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
