'use strict';

/**
 * 端到端测试（设计 TASK-5/6/7/8）：直接调用 run()，注入临时 cwd / env / now。
 * 每条 AC 一组用例；连续多次 run 指向同一数据文件即等价 PRD 的“重启”（AC-12），无需 child_process。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../workorder');

const D1 = '2026-11-12';
const D2 = '2026-11-13';
const D3 = '2026-11-14';
const NOW_D1 = new Date(2026, 10, 12, 9, 0, 0);
const NOW_D2 = new Date(2026, 10, 13, 9, 0, 0);

const LIST_HEADER = '工单号 | 产品 | 计划 | 累计合格 | 累计不良 | 进度 | 状态';
const USAGE = '错误：用法不正确，子命令：create|report|list|detail|query\n';
const NO_ORDERS = '（暂无工单）\n';
const NO_RECORDS = '（无报工记录）\n';

function tmpWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-cli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function opts(dir, extra) {
  return { cwd: dir, env: {}, ...(extra || {}) };
}

function lines(out) {
  return out.split('\n').filter((s) => s !== '');
}

// ---------- AC-1 ----------

test('AC-1 创建成功、初始状态与列表聚合', (t) => {
  const dir = tmpWorkspace(t);
  const r = run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, '已创建：WO-20261112-01\n');
  const l = run(['list'], opts(dir));
  assert.equal(l.code, 0);
  assert.deepEqual(lines(l.out), [
    LIST_HEADER,
    'WO-20261112-01 | 支架 | 100 | 0 | 0 | 0% | 待开工',
  ]);
});

// ---------- AC-2 ----------

test('AC-2 当日序号递增、跨日重置（注入次日 now 模拟）', (t) => {
  const dir = tmpWorkspace(t);
  const r1 = run(['create', 'A', '10'], opts(dir, { now: NOW_D1 }));
  const r2 = run(['create', 'B', '10'], opts(dir, { now: NOW_D1 }));
  assert.equal(r1.out, '已创建：WO-20261112-01\n');
  assert.equal(r2.out, '已创建：WO-20261112-02\n');
  const r3 = run(['create', 'C', '10'], opts(dir, { now: NOW_D2 }));
  assert.equal(r3.out, '已创建：WO-20261113-01\n');
  const l = run(['list'], opts(dir));
  assert.deepEqual(lines(l.out), [
    LIST_HEADER,
    'WO-20261112-01 | A | 10 | 0 | 0 | 0% | 待开工',
    'WO-20261112-02 | B | 10 | 0 | 0 | 0% | 待开工',
    'WO-20261113-01 | C | 10 | 0 | 0 | 0% | 待开工',
  ]);
});

// ---------- AC-3 ----------

test('AC-3 创建非法输入拒绝（空名/0/-5/2.5/abc），工单总数不变', (t) => {
  const dir = tmpWorkspace(t);
  const cases = [
    [['create', '', '100'], '错误：产品名称不能为空'],
    [['create', '支架', '0'], '错误：计划数量必须为正整数：0'],
    [['create', '支架', '-5'], '错误：计划数量必须为正整数：-5'],
    [['create', '支架', '2.5'], '错误：计划数量必须为正整数：2.5'],
    [['create', '支架', 'abc'], '错误：计划数量必须为正整数：abc'],
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir, { now: NOW_D1 }));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.err, `${message}\n`, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
  }
  const l = run(['list'], opts(dir));
  assert.equal(l.out, NO_ORDERS);
  // 全部失败：数据文件从未被创建（拒绝即无任何数据变更）
  assert.equal(fs.existsSync(path.join(dir, 'data.json')), false);
});

// ---------- AC-4 ----------

test('AC-4 两笔报工后列表聚合（70/3/70%/进行中）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  const r1 = run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  assert.equal(r1.code, 0);
  assert.equal(r1.out, '报工成功：WO-20261112-01（累计合格 30，累计不良 2，状态：进行中）\n');
  const r2 = run(['report', 'WO-20261112-01', D2, '李四', '40', '1'], opts(dir));
  assert.equal(r2.code, 0);
  assert.equal(r2.out, '报工成功：WO-20261112-01（累计合格 70，累计不良 3，状态：进行中）\n');
  const l = run(['list'], opts(dir));
  assert.deepEqual(lines(l.out), [
    LIST_HEADER,
    'WO-20261112-01 | 支架 | 100 | 70 | 3 | 70% | 进行中',
  ]);
});

// ---------- AC-5 ----------

test('AC-5 详情 3 条及排序（先日期、同日按录入先后）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  run(['report', 'WO-20261112-01', D2, '李四', '40', '1'], opts(dir));
  run(['report', 'WO-20261112-01', D1, '王五', '5', '0'], opts(dir));
  const d = run(['detail', 'WO-20261112-01'], opts(dir));
  assert.equal(d.code, 0);
  assert.deepEqual(lines(d.out), [
    'WO-20261112-01 | 支架 | 100 | 75 | 3 | 75% | 进行中',
    `${D1} | 张三 | 30 | 2`,
    `${D1} | 王五 | 5 | 0`,
    `${D2} | 李四 | 40 | 1`,
  ]);
});

// ---------- AC-6 ----------

test('AC-6 报工/详情对不存在工单报错，数据无任何变化', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  const file = path.join(dir, 'data.json');
  const before = fs.readFileSync(file, 'utf8');
  const miss = 'WO-19990101-99';
  const r = run(['report', miss, D1, '张三', '30', '2'], opts(dir));
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err, `错误：工单不存在：${miss}\n`);
  const d = run(['detail', miss], opts(dir));
  assert.equal(d.code, 1);
  assert.equal(d.err, `错误：工单不存在：${miss}\n`);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| 支架 \| 100 \| 0 \| 0 \| 0% \| 待开工/);
});

// ---------- AC-7 ----------

test('AC-7 达标自动完工并拒绝后续报工（累计与记录数不变）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  const r1 = run(['report', 'WO-20261112-01', D1, '张三', '100', '0'], opts(dir));
  assert.equal(r1.code, 0);
  assert.equal(r1.out, '报工成功：WO-20261112-01（累计合格 100，累计不良 0，状态：已完成）\n');
  const r2 = run(['report', 'WO-20261112-01', D2, '李四', '1', '0'], opts(dir));
  assert.equal(r2.code, 1);
  assert.equal(r2.err, '错误：工单已完工，拒绝报工：WO-20261112-01\n');
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| 支架 \| 100 \| 100 \| 0 \| 100% \| 已完成/);
  const d = run(['detail', 'WO-20261112-01'], opts(dir));
  assert.equal(lines(d.out).length, 2); // 聚合行 + 仅 1 条记录
});

// ---------- AC-8 ----------

test('AC-8 单笔超额 120%：报工成功、已完成、进度不封顶', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  const r = run(['report', 'WO-20261112-01', D1, '张三', '120', '0'], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, '报工成功：WO-20261112-01（累计合格 120，累计不良 0，状态：已完成）\n');
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| 支架 \| 100 \| 120 \| 0 \| 120% \| 已完成/);
});

// ---------- AC-9 ----------

test('AC-9 七类非法报工逐项可区分拒绝，累计数/记录数/状态均不变', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir)); // 使其处于进行中
  const file = path.join(dir, 'data.json');
  const before = fs.readFileSync(file, 'utf8');
  const id = 'WO-20261112-01';
  const cases = [
    [['report', id, D2, '李四', '-1', '0'], '错误：合格数量不能为负数'],
    [['report', id, D2, '李四', '1.5', '0'], '错误：合格数量必须为不小于 0 的整数'],
    [['report', id, D2, '李四', '0', '-2'], '错误：不良数量不能为负数'],
    [['report', id, D2, '李四', '0', '2.5'], '错误：不良数量必须为不小于 0 的整数'],
    [['report', id, D2, '李四', '0', '0'], '错误：合格数与不良数不得同时为 0'],
    [
      ['report', id, '2026-02-30', '李四', '1', '0'],
      '错误：报工日期无效，须为 YYYY-MM-DD 的有效日历日期：2026-02-30',
    ],
    [
      ['report', id, 'abc', '李四', '1', '0'],
      '错误：报工日期无效，须为 YYYY-MM-DD 的有效日历日期：abc',
    ],
    [['report', id, D2, '', '1', '0'], '错误：操作工不能为空'],
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.err, `${message}\n`, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before); // 全部拒绝：磁盘不变
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| 支架 \| 100 \| 30 \| 2 \| 30% \| 进行中/);
});

// ---------- AC-10 ----------

test('AC-10 按日查询（仅 D1 那笔）与空日提示（退出码 0）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  run(['report', 'WO-20261112-01', D2, '李四', '40', '1'], opts(dir));
  const q1 = run(['query', D1], opts(dir));
  assert.equal(q1.code, 0);
  assert.deepEqual(lines(q1.out), [`${D1} | WO-20261112-01 | 张三 | 30 | 2`]);
  const q3 = run(['query', D3], opts(dir));
  assert.equal(q3.code, 0);
  assert.equal(q3.out, NO_RECORDS);
  assert.equal(q3.err, '');
});

// ---------- AC-11 ----------

test('AC-11 查询筛选：工单号/操作工/组合（AND，无命中不报错）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', 'A', '100'], opts(dir, { now: NOW_D1 }));
  run(['create', 'B', '50'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  run(['report', 'WO-20261112-02', D1, '李四', '10', '0'], opts(dir));
  const q1 = run(['query', D1, '--wo', 'WO-20261112-01'], opts(dir));
  assert.equal(q1.code, 0);
  assert.deepEqual(lines(q1.out), [`${D1} | WO-20261112-01 | 张三 | 30 | 2`]);
  const q2 = run(['query', D1, '--worker', '李四'], opts(dir));
  assert.equal(q2.code, 0);
  assert.deepEqual(lines(q2.out), [`${D1} | WO-20261112-02 | 李四 | 10 | 0`]);
  const q3 = run(['query', D1, '--wo', 'WO-20261112-01', '--worker', '李四'], opts(dir));
  assert.equal(q3.code, 0);
  assert.equal(q3.out, NO_RECORDS);
});

// ---------- AC-12 ----------

test('AC-12 连续多次 run（模拟重启）后数据完整，并可继续报工', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  run(['report', 'WO-20261112-01', D2, '李四', '40', '1'], opts(dir));
  // “重启”：全新 run 读取同一数据文件
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| 支架 \| 100 \| 70 \| 3 \| 70% \| 进行中/);
  const d = run(['detail', 'WO-20261112-01'], opts(dir));
  assert.deepEqual(lines(d.out), [
    'WO-20261112-01 | 支架 | 100 | 70 | 3 | 70% | 进行中',
    `${D1} | 张三 | 30 | 2`,
    `${D2} | 李四 | 40 | 1`,
  ]);
  // 重启后继续追加报工，累计仍正确并自动完工
  const r = run(['report', 'WO-20261112-01', D3, '王五', '30', '0'], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, '报工成功：WO-20261112-01（累计合格 100，累计不良 3，状态：已完成）\n');
  const l2 = run(['list'], opts(dir));
  assert.match(l2.out, /WO-20261112-01 \| 支架 \| 100 \| 100 \| 3 \| 100% \| 已完成/);
});

// ---------- AC-13 ----------

test('AC-13 默认运行目录生成 data.json 且包含工单数据', (t) => {
  const dir = tmpWorkspace(t);
  const r = run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  assert.equal(r.code, 0);
  const file = path.join(dir, 'data.json');
  assert.equal(fs.existsSync(file), true);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].id, 'WO-20261112-01');
  assert.equal(data.orders[0].product, '支架');
  assert.equal(data.seq['20261112'], 1);
});

// ---------- AC-14 ----------

test('AC-14 WORKORDER_DATA_FILE 完全接管：写新路径、默认文件不被创建、同 env 可读回', (t) => {
  const dir = tmpWorkspace(t);
  fs.mkdirSync(path.join(dir, 'custom'));
  const custom = path.join(dir, 'custom', 'p.json');
  const env = { WORKORDER_DATA_FILE: custom };
  const r1 = run(['create', '支架', '100'], { cwd: dir, env, now: NOW_D1 });
  assert.equal(r1.code, 0);
  assert.equal(fs.existsSync(custom), true);
  assert.equal(fs.existsSync(path.join(dir, 'data.json')), false); // 默认文件未被创建/修改
  const r2 = run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], { cwd: dir, env, now: NOW_D1 });
  assert.equal(r2.code, 0);
  const q = run(['query', D1], { cwd: dir, env });
  assert.equal(q.code, 0);
  assert.deepEqual(lines(q.out), [`${D1} | WO-20261112-01 | 张三 | 30 | 2`]);
  // 无 env 时默认文件不存在且未被触碰 → 仍为空数据
  const l = run(['list'], opts(dir));
  assert.equal(l.out, NO_ORDERS);
});

// ---------- AC-15 ----------

test('AC-15 空数据列表：提示、退出码 0、无伪造数据', (t) => {
  const dir = tmpWorkspace(t);
  const l = run(['list'], opts(dir));
  assert.equal(l.code, 0);
  assert.equal(l.out, NO_ORDERS);
  assert.equal(l.err, '');
  assert.equal(fs.existsSync(path.join(dir, 'data.json')), false); // 纯读命令不创建数据文件
});

// ---------- 用法错误 ----------

test('用法错误：无/未知命令、参数个数不符、未知选项、缺选项值', (t) => {
  const dir = tmpWorkspace(t);
  const cases = [
    [],
    ['foo'],
    ['CREATE', '支架', '100'],
    ['create', '支架'],
    ['create', '支架', '100', 'extra'],
    ['report', 'WO-20261112-01', D1, '张三', '1'],
    ['report', 'WO-20261112-01', D1, '张三', '1', '0', 'extra'],
    ['list', 'extra'],
    ['list', '--wo', 'X'],
    ['detail'],
    ['detail', 'WO-20261112-01', 'extra'],
    ['query'],
    ['query', D1, '--wo'],
    ['query', D1, '--wo', 'X', '--bad', 'Y'],
    ['--wo', 'X', 'query', D1],
  ];
  for (const argv of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.err, USAGE, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
  }
});

// ---------- 损坏数据文件（裁决 3） ----------

test('损坏数据文件：明确报错、不覆盖、不重建（JSON.parse 失败）', (t) => {
  const dir = tmpWorkspace(t);
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{oops', 'utf8');
  const cases = [
    ['list'],
    ['create', '支架', '100'],
    ['query', D1],
    ['detail', 'WO-20261112-01'],
    ['report', 'WO-20261112-01', D1, '张三', '1', '0'],
  ];
  for (const argv of cases) {
    const r = run(argv, opts(dir, { now: NOW_D1 }));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(
      r.err,
      `错误：数据文件已损坏，已拒绝读写：${file}（请人工处理后重试）\n`,
      JSON.stringify(argv)
    );
    assert.equal(r.out, '', JSON.stringify(argv));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{oops'); // 未被覆盖
});

test('损坏数据文件（orders 非数组）：同样拒绝且不覆盖', (t) => {
  const dir = tmpWorkspace(t);
  const file = path.join(dir, 'data.json');
  const text = '{"orders":1,"seq":{}}';
  fs.writeFileSync(file, text, 'utf8');
  const r = run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  assert.equal(r.code, 1);
  assert.equal(r.err, `错误：数据文件已损坏，已拒绝读写：${file}（请人工处理后重试）\n`);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

// ---------- 设计留白处行为补充 ----------

test('detail 已创建未报工：聚合行 +（无报工记录）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  const d = run(['detail', 'WO-20261112-01'], opts(dir));
  assert.equal(d.code, 0);
  assert.deepEqual(lines(d.out), [
    'WO-20261112-01 | 支架 | 100 | 0 | 0 | 0% | 待开工',
    '（无报工记录）',
  ]);
});

test('query 无效日期按错误处理，退出码 1（设计 §8 开放问题 1 的既定裁决）', (t) => {
  const dir = tmpWorkspace(t);
  const r = run(['query', '2026-02-30'], opts(dir));
  assert.equal(r.code, 1);
  assert.equal(r.err, '错误：报工日期无效，须为 YYYY-MM-DD 的有效日历日期：2026-02-30\n');
  assert.equal(r.out, '');
});

// ---------- 本期新增：stat / export（docs/workorder-monthly-csv TASK-3/TASK-4，AC-1~AC-10 命令级） ----------

const YM1 = '2026-11';
const YM2 = '2026-12';
const NO_MONTH = '（该月无报工记录）\n';
const BOM = '\uFEFF';
const CSV_HEADER = '日期,工单号,操作工,合格数量,不良数量';
const invalidYm = (ym) => `错误：年月无效，须为 YYYY-MM 且月份为 01-12：${ym}\n`;

/** AC-1 承载数据：一单三笔（D1 张三 30/2、D2 李四 40/1、D1 王五 5/0） */
function monthWorkspace(t) {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  run(['report', 'WO-20261112-01', D2, '李四', '40', '1'], opts(dir));
  run(['report', 'WO-20261112-01', D1, '王五', '5', '0'], opts(dir));
  return dir;
}

test('stat 月度合计：恰三行、退出码 0（AC-1 命令级）', (t) => {
  const dir = monthWorkspace(t);
  const r = run(['stat', YM1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, '报工笔数：3\n合格总数：75\n不良总数：3\n');
});

test('stat 跨工单合并：2 笔 / 40 / 2，不分工单展示（AC-2 命令级）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', 'A', '100'], opts(dir, { now: NOW_D1 }));
  run(['create', 'B', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  run(['report', 'WO-20261112-02', D2, '李四', '10', '0'], opts(dir));
  const r = run(['stat', YM1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, '报工笔数：2\n合格总数：40\n不良总数：2\n');
});

test('stat 空月：提示、退出码 0、无伪造数字（AC-3）；无数据文件同样为空提示且不建文件', (t) => {
  const dir = monthWorkspace(t);
  const r = run(['stat', YM2], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, NO_MONTH);
  assert.equal(r.err, '');
  const dir2 = tmpWorkspace(t);
  const r2 = run(['stat', YM1], opts(dir2));
  assert.equal(r2.code, 0);
  assert.equal(r2.out, NO_MONTH);
  assert.equal(fs.existsSync(path.join(dir2, 'data.json')), false); // 只读命令不创建数据文件
});

test('stat 六类非法年月拒绝：code 1、stdout 空（无统计数字）；缺省走既有用法错误旧文案（AC-4）', (t) => {
  const dir = monthWorkspace(t);
  const file = path.join(dir, 'data.json');
  const before = fs.readFileSync(file, 'utf8');
  const cases = [
    [['stat', '2026-13'], invalidYm('2026-13')],
    [['stat', '2026-00'], invalidYm('2026-00')],
    [['stat', '2026-1'], invalidYm('2026-1')],
    [['stat', '202601'], invalidYm('202601')],
    [['stat', 'abc'], invalidYm('abc')],
    [['stat'], USAGE], // 缺省年月：既有用法错误（文案保持不变，裁决 1）
    [['stat', YM1, 'extra'], USAGE],
    [['stat', '--wo', 'X'], USAGE], // stat 无选项
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
    assert.equal(r.err, message, JSON.stringify(argv));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before); // 只读：磁盘字节不变
});

test('stat 月份隔离：M1 与 M2 互不混入（AC-5 命令级）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '0'], opts(dir));
  run(['report', 'WO-20261112-01', '2026-12-20', '李四', '20', '0'], opts(dir));
  assert.equal(run(['stat', YM1], opts(dir)).out, '报工笔数：1\n合格总数：30\n不良总数：0\n');
  assert.equal(run(['stat', YM2], opts(dir)).out, '报工笔数：1\n合格总数：20\n不良总数：0\n');
});

test('export 成功输出 = BOM + CSV、err 为空、行序日期升序同日按录入先后（AC-6/AC-10 命令级）', (t) => {
  const dir = monthWorkspace(t);
  const r = run(['export', YM1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.ok(r.out.startsWith(BOM), '输出应以 BOM 字符（\\uFEFF）开头');
  assert.equal(
    r.out.slice(1),
    [
      CSV_HEADER,
      `${D1},WO-20261112-01,张三,30,2`,
      `${D1},WO-20261112-01,王五,5,0`,
      `${D2},WO-20261112-01,李四,40,1`,
    ].join('\n') + '\n'
  );
});

test('export 含逗号/双引号字段：引号包裹 + 引号双写（AC-7 命令级）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三,李四', '10', '0'], opts(dir));
  run(['report', 'WO-20261112-01', D1, '王"五"', '5', '0'], opts(dir));
  const r = run(['export', YM1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(
    r.out,
    BOM +
      [CSV_HEADER, `${D1},WO-20261112-01,"张三,李四",10,0`, `${D1},WO-20261112-01,"王""五""",5,0`].join('\n') +
      '\n'
  );
});

test('export 空月：BOM + 仅表头一行、退出码 0（AC-8）；无数据文件同样仅表头且不建文件', (t) => {
  const dir = monthWorkspace(t);
  const r = run(['export', YM2], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, BOM + `${CSV_HEADER}\n`);
  const dir2 = tmpWorkspace(t);
  const r2 = run(['export', YM1], opts(dir2));
  assert.equal(r2.code, 0);
  assert.equal(r2.out, BOM + `${CSV_HEADER}\n`);
  assert.equal(fs.existsSync(path.join(dir2, 'data.json')), false);
});

test('export 六类非法年月拒绝：code 1、stdout 为空（无 BOM 无表头无数据行，无残缺 CSV）（AC-9）', (t) => {
  const dir = monthWorkspace(t);
  const file = path.join(dir, 'data.json');
  const before = fs.readFileSync(file, 'utf8');
  const cases = [
    [['export', '2026-13'], invalidYm('2026-13')],
    [['export', '2026-00'], invalidYm('2026-00')],
    [['export', '2026-1'], invalidYm('2026-1')],
    [['export', '202601'], invalidYm('202601')],
    [['export', 'abc'], invalidYm('abc')],
    [['export'], USAGE],
    [['export', YM1, 'extra'], USAGE],
    [['export', '--worker', 'X'], USAGE], // export 无选项
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
    assert.equal(r.err, message, JSON.stringify(argv));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before); // 只读：磁盘字节不变
});

test('stat/export 损坏数据文件：既有损坏文案、stdout 空、不覆盖（只读同样先 load 后判损坏）', (t) => {
  const dir = tmpWorkspace(t);
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{oops', 'utf8');
  for (const argv of [['stat', YM1], ['export', YM1]]) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
    assert.equal(
      r.err,
      `错误：数据文件已损坏，已拒绝读写：${file}（请人工处理后重试）\n`,
      JSON.stringify(argv)
    );
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{oops'); // 未被覆盖
});
