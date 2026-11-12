'use strict';

/**
 * 验收测试（测试角色产出）—— 按 PRD AC-1 ~ AC-15 逐条设计用例（正常路径 + 边界 + 异常输入）。
 *
 * 约束遵守：
 * - 框架仅用 Node 内置 node:test（`node --test` 执行），零第三方依赖；
 *   真实进程冒烟用 node:child_process 的 spawnSync（同为内置模块）。
 * - 只新增本文件；不修改产品代码与既有测试文件。
 *
 * 两类执行方式：
 * 1) run() 注入（cwd / env / now）：确定性覆盖全部 AC；
 * 2) spawnSync 真实子进程：验证真实 CLI 入口、退出码、stdout/stderr 分流、
 *    环境变量继承与"进程级重启"（AC-12/13/14 的最强证据）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { run } = require('../workorder');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'workorder.js');

const D1 = '2026-11-12';
const D2 = '2026-11-13';
const D3 = '2026-11-14';
const NOW_D1 = new Date(2026, 10, 12, 9, 0, 0);
const NOW_D2 = new Date(2026, 10, 13, 9, 0, 0);

const LIST_HEADER = '工单号 | 产品 | 计划 | 累计合格 | 累计不良 | 进度 | 状态';
const NO_ORDERS = '（暂无工单）\n';
const NO_RECORDS = '（无报工记录）\n';
const USAGE = '错误：用法不正确，子命令：create|report|list|detail|query\n';

// ---------- 通用辅助 ----------

function tmpWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-accept-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function opts(dir, extra) {
  return { cwd: dir, env: {}, ...(extra || {}) };
}

function lines(out) {
  return out.split('\n').filter((s) => s !== '');
}

function snapshot(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** 构造真实子进程环境：继承宿主环境但剥离被测变量（可再叠加覆盖项） */
function childEnv(extra) {
  const env = { ...process.env };
  delete env.WORKORDER_DATA_FILE;
  return Object.assign(env, extra || {});
}

/** 真实 CLI 子进程：每次调用都是一次独立进程（等价真实"重启"） */
function cli(args, cwd, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: env || childEnv(),
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function assertNoAnsi(text, label) {
  assert.ok(!text.includes(''), `${label} 含 ANSI 转义序列，违反 FR-9 纯文本输出`);
}

// ---------- AC-1 创建成功与初始状态 ----------

test('AC-1 正常：创建成功输出 WO-<当日>-01，列表显示初始 0/0/0%/待开工', (t) => {
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

test('AC-1 正常（真实系统日期）：不注入 now 时工单号日期部分为本机当日', (t) => {
  const dir = tmpWorkspace(t);
  const d = new Date();
  const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}`;
  const r = run(['create', '轴承', '10'], { cwd: dir, env: {} });
  assert.equal(r.code, 0);
  assert.equal(r.out, `已创建：WO-${key}-01\n`);
  const l = run(['list'], { cwd: dir, env: {} });
  assert.match(l.out, new RegExp(`^WO-${key}-01 \\| 轴承 \\| 10 \\| 0 \\| 0 \\| 0% \\| 待开工$`, 'm'));
});

test('AC-1 边界：计划数量=1（最小正整数）成功；产品名称内部空格原样保留', (t) => {
  const dir = tmpWorkspace(t);
  const r1 = run(['create', '精密 支架', '1'], opts(dir, { now: NOW_D1 }));
  assert.equal(r1.code, 0);
  assert.equal(r1.out, '已创建：WO-20261112-01\n');
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| 精密 支架 \| 1 \| 0 \| 0 \| 0% \| 待开工/);
});

test('AC-1 异常：产品名称为纯空白（"   "）被拒绝', (t) => {
  const dir = tmpWorkspace(t);
  const r = run(['create', '   ', '100'], opts(dir, { now: NOW_D1 }));
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err, '错误：产品名称不能为空\n');
  assert.equal(run(['list'], opts(dir)).out, NO_ORDERS);
});

// ---------- AC-2 当日序号递增 ----------

test('AC-2 正常：当日连续两单序号 01→02 且工单号互不相同', (t) => {
  const dir = tmpWorkspace(t);
  const r1 = run(['create', 'A', '10'], opts(dir, { now: NOW_D1 }));
  const r2 = run(['create', 'B', '10'], opts(dir, { now: NOW_D1 }));
  assert.equal(r1.out, '已创建：WO-20261112-01\n');
  assert.equal(r2.out, '已创建：WO-20261112-02\n');
  assert.notEqual(r1.out, r2.out);
});

test('AC-2 边界：跨日重置为 01，且旧日期序号保留（回到 D1 再创建得 03）', (t) => {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', 'A', '10'], opts(dir, { now: NOW_D1 })).out, '已创建：WO-20261112-01\n');
  assert.equal(run(['create', 'B', '10'], opts(dir, { now: NOW_D2 })).out, '已创建：WO-20261113-01\n');
  // 回到 D1（注入历史 now）：旧日期 seq 未被跨日创建破坏
  assert.equal(run(['create', 'C', '10'], opts(dir, { now: NOW_D1 })).out, '已创建：WO-20261112-02\n');
  const file = path.join(dir, 'data.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data.seq, { '20261112': 2, '20261113': 1 });
});

test('AC-2 边界：当日第 100 单序号自然扩位为 -100，列表按创建顺序排列', (t) => {
  const dir = tmpWorkspace(t);
  let last = '';
  for (let i = 1; i <= 100; i += 1) {
    const r = run(['create', `P${i}`, '10'], opts(dir, { now: NOW_D1 }));
    assert.equal(r.code, 0, `第 ${i} 单创建失败`);
    last = r.out;
  }
  assert.equal(last, '已创建：WO-20261112-100\n');
  const l = run(['list'], opts(dir));
  assert.equal(l.code, 0);
  assert.equal(lines(l.out).length, 101); // 表头 + 100 行
  const idx99 = l.out.indexOf('WO-20261112-99 |');
  const idx100 = l.out.indexOf('WO-20261112-100 |');
  assert.ok(idx99 > 0, '第 99 单应在列表中');
  assert.ok(idx100 > idx99, '列表必须按创建顺序（-99 在 -100 之前），而非工单号字符串序');
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(data.seq['20261112'], 100);
});

test('AC-2 异常：被拒绝的创建不消耗当日序号（失败后成功单仍得 02）', (t) => {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', 'A', '10'], opts(dir, { now: NOW_D1 })).out, '已创建：WO-20261112-01\n');
  const bad = run(['create', 'B', '0'], opts(dir, { now: NOW_D1 }));
  assert.equal(bad.code, 1);
  assert.equal(run(['create', 'C', '10'], opts(dir, { now: NOW_D1 })).out, '已创建：WO-20261112-02\n');
});

// ---------- AC-3 创建非法输入拒绝 ----------

test('AC-3 异常：空名/计划 0/-5/2.5/abc/1e2/空串 逐项拒绝且报错可区分', (t) => {
  const dir = tmpWorkspace(t);
  const cases = [
    [['create', '', '100'], '错误：产品名称不能为空'],
    [['create', '支架', '0'], '错误：计划数量必须为正整数：0'],
    [['create', '支架', '-5'], '错误：计划数量必须为正整数：-5'],
    [['create', '支架', '2.5'], '错误：计划数量必须为正整数：2.5'],
    [['create', '支架', 'abc'], '错误：计划数量必须为正整数：abc'],
    [['create', '支架', '1e2'], '错误：计划数量必须为正整数：1e2'],
    [['create', '支架', ''], '错误：计划数量必须为正整数：'],
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir, { now: NOW_D1 }));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
    assert.equal(r.err, `${message}\n`, JSON.stringify(argv));
  }
});

test('AC-3 异常：全部拒绝后工单总数不变、不生成数据文件；随后正常创建成功', (t) => {
  const dir = tmpWorkspace(t);
  for (const argv of [
    ['create', '', '100'],
    ['create', '支架', '0'],
    ['create', '支架', '-5'],
    ['create', '支架', '2.5'],
    ['create', '支架', 'abc'],
  ]) {
    run(argv, opts(dir, { now: NOW_D1 }));
  }
  assert.equal(run(['list'], opts(dir)).out, NO_ORDERS); // 总数仍为 0
  assert.equal(fs.existsSync(path.join(dir, 'data.json')), false); // 无数据落盘
  const ok = run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  assert.equal(ok.code, 0);
  assert.equal(ok.out, '已创建：WO-20261112-01\n'); // 序号从 01 起，未被失败占用
});

// ---------- AC-4 报工成功与列表聚合 ----------

test('AC-4 正常：两笔报工累计 70/3/70%/进行中，成功文案正确', (t) => {
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

test('AC-4 边界：仅不良报工（0/5）成功且待开工→进行中、进度 0%；两工单聚合互不串扰', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', 'A', '100'], opts(dir, { now: NOW_D1 }));
  run(['create', 'B', '50'], opts(dir, { now: NOW_D1 }));
  const r = run(['report', 'WO-20261112-01', D1, '张三', '0', '5'], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, '报工成功：WO-20261112-01（累计合格 0，累计不良 5，状态：进行中）\n');
  const r2 = run(['report', 'WO-20261112-02', D1, '李四', '10', '0'], opts(dir));
  assert.equal(r2.out, '报工成功：WO-20261112-02（累计合格 10，累计不良 0，状态：进行中）\n');
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| A \| 100 \| 0 \| 5 \| 0% \| 进行中/);
  assert.match(l.out, /WO-20261112-02 \| B \| 50 \| 10 \| 0 \| 20% \| 进行中/);
});

// ---------- AC-5 详情内容与排序 ----------

test('AC-5 正常：3 条记录按 D1张三→D1王五→D2李四 排序，每条含日期/操作工/合格/不良', (t) => {
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

test('AC-5 边界：同日 4 笔严格按录入先后；0 笔时输出聚合行+（无报工记录）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', 'X', '1000'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '甲', '1', '0'], opts(dir));
  run(['report', 'WO-20261112-01', D1, '乙', '1', '0'], opts(dir));
  run(['report', 'WO-20261112-01', D1, '丙', '1', '0'], opts(dir));
  run(['report', 'WO-20261112-01', D1, '丁', '1', '0'], opts(dir));
  const d = run(['detail', 'WO-20261112-01'], opts(dir));
  assert.deepEqual(lines(d.out).slice(1), [
    `${D1} | 甲 | 1 | 0`,
    `${D1} | 乙 | 1 | 0`,
    `${D1} | 丙 | 1 | 0`,
    `${D1} | 丁 | 1 | 0`,
  ]);
  const dir2 = tmpWorkspace(t);
  run(['create', 'Y', '10'], opts(dir2, { now: NOW_D1 }));
  const d2 = run(['detail', 'WO-20261112-01'], opts(dir2));
  assert.equal(d2.code, 0);
  assert.deepEqual(lines(d2.out), [
    'WO-20261112-01 | Y | 10 | 0 | 0 | 0% | 待开工',
    '（无报工记录）',
  ]);
});

// ---------- AC-6 工单号不存在 ----------

test('AC-6 异常：对不存在工单报工与详情均明确报错且磁盘字节不变', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  const file = path.join(dir, 'data.json');
  const before = snapshot(file);
  const miss = 'WO-19990101-99';
  const r = run(['report', miss, D1, '张三', '30', '2'], opts(dir));
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err, `错误：工单不存在：${miss}\n`);
  const d = run(['detail', miss], opts(dir));
  assert.equal(d.code, 1);
  assert.equal(d.out, '');
  assert.equal(d.err, `错误：工单不存在：${miss}\n`);
  assert.equal(snapshot(file), before); // 数据无任何变化（字节级）
});

test('AC-6 边界：大小写/缩位/带空白等近似工单号一律精确匹配失败', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  for (const id of ['wo-20261112-01', 'WO-20261112-1', ' WO-20261112-01', 'WO-20261112-01 ', 'WO-20261112-02']) {
    const d = run(['detail', id], opts(dir));
    assert.equal(d.code, 1, JSON.stringify(id));
    assert.equal(d.err, `错误：工单不存在：${id}\n`, JSON.stringify(id));
  }
  assert.equal(run(['detail', 'WO-20261112-01'], opts(dir)).code, 0); // 正确号不受影响
});

// ---------- AC-7 达标自动完工并拒绝后续报工 ----------

test('AC-7 正常：100/0 一笔直达已完成；二次报工被拒且累计/记录数不变（字节级）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  const r1 = run(['report', 'WO-20261112-01', D1, '张三', '100', '0'], opts(dir));
  assert.equal(r1.code, 0);
  assert.equal(r1.out, '报工成功：WO-20261112-01（累计合格 100，累计不良 0，状态：已完成）\n');
  const file = path.join(dir, 'data.json');
  const before = snapshot(file);
  const r2 = run(['report', 'WO-20261112-01', D2, '李四', '1', '0'], opts(dir));
  assert.equal(r2.code, 1);
  assert.equal(r2.err, '错误：工单已完工，拒绝报工：WO-20261112-01\n');
  assert.equal(r2.out, '');
  assert.equal(snapshot(file), before); // 拒绝即无任何数据变更
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| 支架 \| 100 \| 100 \| 0 \| 100% \| 已完成/);
  const d = run(['detail', 'WO-20261112-01'], opts(dir));
  assert.equal(lines(d.out).length, 2); // 聚合行 + 仅 1 条记录
});

test('AC-7 边界：60+40 恰好达标完工；已完工单拒绝仅不良报工；其他工单不受影响', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', 'A', '100'], opts(dir, { now: NOW_D1 }));
  run(['create', 'B', '10'], opts(dir, { now: NOW_D1 }));
  assert.match(run(['report', 'WO-20261112-01', D1, '张三', '60', '0'], opts(dir)).out, /状态：进行中/);
  const r2 = run(['report', 'WO-20261112-01', D2, '李四', '40', '0'], opts(dir));
  assert.match(r2.out, /累计合格 100，累计不良 0，状态：已完成/);
  const r3 = run(['report', 'WO-20261112-01', D2, '王五', '0', '1'], opts(dir));
  assert.equal(r3.code, 1);
  assert.equal(r3.err, '错误：工单已完工，拒绝报工：WO-20261112-01\n');
  // 已完工的 A 不影响 B 继续报工
  const r4 = run(['report', 'WO-20261112-02', D2, '赵六', '5', '5'], opts(dir));
  assert.equal(r4.code, 0);
  assert.match(r4.out, /状态：进行中/);
});

// ---------- AC-8 单笔超额报工 ----------

test('AC-8 正常：单笔 120/0 → 成功、已完成、列表与详情均显示 120%', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  const r = run(['report', 'WO-20261112-01', D1, '张三', '120', '0'], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, '报工成功：WO-20261112-01（累计合格 120，累计不良 0，状态：已完成）\n');
  assert.match(run(['list'], opts(dir)).out, /WO-20261112-01 \| 支架 \| 100 \| 120 \| 0 \| 120% \| 已完成/);
  const d = run(['detail', 'WO-20261112-01'], opts(dir));
  assert.equal(lines(d.out)[0], 'WO-20261112-01 | 支架 | 100 | 120 | 0 | 120% | 已完成');
});

test('AC-8 边界：进度四舍五入 1/3→33%、2/3→67%、3/3→100%；计划 1 报 1000 → 100000%', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', 'X', '3'], opts(dir, { now: NOW_D1 }));
  assert.match(run(['report', 'WO-20261112-01', D1, '甲', '1', '0'], opts(dir)).out, /累计合格 1/);
  assert.match(run(['list'], opts(dir)).out, /\| 33% \| 进行中/);
  assert.match(run(['report', 'WO-20261112-01', D1, '甲', '1', '0'], opts(dir)).out, /累计合格 2/);
  assert.match(run(['list'], opts(dir)).out, /\| 67% \| 进行中/);
  const r3 = run(['report', 'WO-20261112-01', D1, '甲', '1', '0'], opts(dir));
  assert.match(r3.out, /状态：已完成/);
  assert.match(run(['list'], opts(dir)).out, /\| 100% \| 已完成/);

  const dir2 = tmpWorkspace(t);
  run(['create', 'Y', '1'], opts(dir2, { now: NOW_D1 }));
  const r = run(['report', 'WO-20261112-01', D1, '乙', '1000', '0'], opts(dir2));
  assert.equal(r.code, 0);
  assert.match(run(['list'], opts(dir2)).out, /\| 1000 \| 0 \| 100000% \| 已完成/);
});

// ---------- AC-9 非法报工逐项拒绝 ----------

test('AC-9 异常：七类非法报工逐项拒绝（负数/非整数/同时0/无效日期/空操作工），三数与磁盘均不变', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir)); // 进行中
  const file = path.join(dir, 'data.json');
  const before = snapshot(file);
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
    [['report', id, D2, '   ', '1', '0'], '错误：操作工不能为空'],
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
    assert.equal(r.err, `${message}\n`, JSON.stringify(argv));
  }
  assert.equal(snapshot(file), before); // 全部拒绝：磁盘字节不变
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| 支架 \| 100 \| 30 \| 2 \| 30% \| 进行中/); // 累计/进度/状态均不变
});

test('AC-9 异常：报错优先级可区分（不存在→已完工→操作工→日期→数量→同时0）', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', 'A', '100'], opts(dir, { now: NOW_D1 }));
  run(['create', 'B', '10'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-02', D1, '张三', '10', '0'], opts(dir)); // B 完工
  const cases = [
    // 不存在优先于一切
    [['report', 'WO-99999999-99', 'bad', '', 'x', 'y'], '错误：工单不存在：WO-99999999-99'],
    // 已完工优先于后续字段校验
    [['report', 'WO-20261112-02', '2026-02-30', '李四', '-1', '-1'], '错误：工单已完工，拒绝报工：WO-20261112-02'],
    // 操作工先于日期
    [['report', 'WO-20261112-01', '2026-02-30', '', '-1', '-1'], '错误：操作工不能为空'],
    // 日期先于数量
    [['report', 'WO-20261112-01', '2026-02-30', '李四', '-1', '-1'], '错误：报工日期无效，须为 YYYY-MM-DD 的有效日历日期：2026-02-30'],
    // 合格先于不良
    [['report', 'WO-20261112-01', D2, '李四', '-1', '-1'], '错误：合格数量不能为负数'],
    [['report', 'WO-20261112-01', D2, '李四', '0', '-1'], '错误：不良数量不能为负数'],
    // 同时为 0 最后
    [['report', 'WO-20261112-01', D2, '李四', '0', '0'], '错误：合格数与不良数不得同时为 0'],
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.err, `${message}\n`, JSON.stringify(argv));
  }
});

test('AC-9 边界：闰年 2024-02-29 合法；2026-02-29、2026-13-01、2026-11-31、尾随空格日期均拒绝', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', 'A', '100'], opts(dir, { now: NOW_D1 }));
  run(['create', 'B', '100'], opts(dir, { now: NOW_D1 }));
  // 闰年边界（合法，允许补录过去，裁决 2）
  const ok = run(['report', 'WO-20261112-02', '2024-02-29', '李四', '1', '0'], opts(dir));
  assert.equal(ok.code, 0);
  // 非闰年 2/29 及其他非法日历日
  for (const bad of ['2026-02-29', '2026-13-01', '2026-11-31', '2026-11-12 ', '2026-00-10', '2026-11-00']) {
    const r = run(['report', 'WO-20261112-01', bad, '张三', '1', '0'], opts(dir));
    assert.equal(r.code, 1, JSON.stringify(bad));
    assert.equal(
      r.err,
      `错误：报工日期无效，须为 YYYY-MM-DD 的有效日历日期：${bad}\n`,
      JSON.stringify(bad)
    );
  }
});

// ---------- AC-10 按日查询（全部与空日） ----------

test('AC-10 正常：查询 D1 仅该笔（含工单号/操作工/数量），D2 仅李四笔', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  run(['report', 'WO-20261112-01', D2, '李四', '40', '1'], opts(dir));
  const q1 = run(['query', D1], opts(dir));
  assert.equal(q1.code, 0);
  assert.equal(q1.err, '');
  assert.deepEqual(lines(q1.out), [`${D1} | WO-20261112-01 | 张三 | 30 | 2`]);
  const q2 = run(['query', D2], opts(dir));
  assert.deepEqual(lines(q2.out), [`${D2} | WO-20261112-01 | 李四 | 40 | 1`]);
});

test('AC-10 边界+异常：无记录日输出空提示（退出码 0）；无数据文件时查询不建文件；无效日期退出码 1', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  const q3 = run(['query', D3], opts(dir));
  assert.equal(q3.code, 0);
  assert.equal(q3.out, NO_RECORDS);
  assert.equal(q3.err, '');
  // 空数据状态（无文件）查询：空提示、退出码 0、不凭空创建 data.json
  const dir2 = tmpWorkspace(t);
  const q0 = run(['query', D1], opts(dir2));
  assert.equal(q0.code, 0);
  assert.equal(q0.out, NO_RECORDS);
  assert.equal(fs.existsSync(path.join(dir2, 'data.json')), false);
  // 无效日期按错误处理（设计 §8 开放问题 1 的既定裁决）
  const bad = run(['query', '2026-02-30'], opts(dir));
  assert.equal(bad.code, 1);
  assert.equal(bad.out, '');
  assert.equal(bad.err, '错误：报工日期无效，须为 YYYY-MM-DD 的有效日历日期：2026-02-30\n');
});

// ---------- AC-11 按日查询筛选 ----------

test('AC-11 正常：--wo / --worker / 组合（AND，空提示不报错）三种筛选', (t) => {
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
  assert.equal(q3.err, '');
});

test('AC-11 边界+异常：同操作工跨两单同日均命中且按创建顺序；不存在筛选值→空提示；未知选项→用法错误', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', 'A', '100'], opts(dir, { now: NOW_D1 }));
  run(['create', 'B', '50'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  run(['report', 'WO-20261112-02', D1, '李四', '10', '0'], opts(dir));
  run(['report', 'WO-20261112-02', D1, '张三', '1', '0'], opts(dir)); // 张三在两单各一笔
  const qw = run(['query', D1, '--worker', '张三'], opts(dir));
  assert.deepEqual(lines(qw.out), [
    `${D1} | WO-20261112-01 | 张三 | 30 | 2`,
    `${D1} | WO-20261112-02 | 张三 | 1 | 0`,
  ]);
  const qm = run(['query', D1, '--wo', 'WO-NOPE'], opts(dir));
  assert.equal(qm.code, 0);
  assert.equal(qm.out, NO_RECORDS);
  const qn = run(['query', D1, '--worker', '不存在的人'], opts(dir));
  assert.equal(qn.code, 0);
  assert.equal(qn.out, NO_RECORDS);
  const bad = run(['query', D1, '--dept', 'X'], opts(dir));
  assert.equal(bad.code, 1);
  assert.equal(bad.err, USAGE);
});

// ---------- AC-12 重启后数据保留 ----------

test('AC-12 正常：连续 run()（模拟重启）后列表/详情完整，重启后可继续报工', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir));
  run(['report', 'WO-20261112-01', D2, '李四', '40', '1'], opts(dir));
  // "重启"：每次 run 都重新从磁盘加载
  const l = run(['list'], opts(dir));
  assert.match(l.out, /WO-20261112-01 \| 支架 \| 100 \| 70 \| 3 \| 70% \| 进行中/);
  const d = run(['detail', 'WO-20261112-01'], opts(dir));
  assert.deepEqual(lines(d.out), [
    'WO-20261112-01 | 支架 | 100 | 70 | 3 | 70% | 进行中',
    `${D1} | 张三 | 30 | 2`,
    `${D2} | 李四 | 40 | 1`,
  ]);
  const q = run(['query', D1], opts(dir));
  assert.deepEqual(lines(q.out), [`${D1} | WO-20261112-01 | 张三 | 30 | 2`]);
  // 重启后继续追加报工，累计仍正确并自动完工
  const r = run(['report', 'WO-20261112-01', D3, '王五', '30', '0'], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, '报工成功：WO-20261112-01（累计合格 100，累计不良 3，状态：已完成）\n');
  assert.match(run(['list'], opts(dir)).out, /WO-20261112-01 \| 支架 \| 100 \| 100 \| 3 \| 100% \| 已完成/);
});

test('AC-12 正常（真实进程级重启）：两次独立 node 子进程，数据完整保留', (t) => {
  const dir = tmpWorkspace(t);
  // 进程 1：创建 + 报工（真实 CLI，真实退出）
  const c1 = cli(['create', '支架', '100'], dir);
  assert.equal(c1.status, 0, `create 退出码异常：${c1.stderr}`);
  assertNoAnsi(c1.stdout, 'create stdout');
  const id = c1.stdout.replace('已创建：', '').trim();
  assert.match(id, /^WO-\d{8}-01$/);
  const c2 = cli(['report', id, D1, '张三', '30', '2'], dir);
  assert.equal(c2.status, 0, `report 退出码异常：${c2.stderr}`);
  // 进程 2：全新进程读同一数据文件（真实"重启"）
  const c3 = cli(['list'], dir);
  assert.equal(c3.status, 0);
  assert.match(c3.stdout, new RegExp(`${id} \\| 支架 \\| 100 \\| 30 \\| 2 \\| 30% \\| 进行中`));
  const c4 = cli(['detail', id], dir);
  assert.equal(c4.status, 0);
  assert.deepEqual(lines(c4.stdout), [
    `${id} | 支架 | 100 | 30 | 2 | 30% | 进行中`,
    `${D1} | 张三 | 30 | 2`,
  ]);
  const c5 = cli(['query', D1], dir);
  assert.equal(c5.status, 0);
  assert.deepEqual(lines(c5.stdout), [`${D1} | ${id} | 张三 | 30 | 2`]);
});

test('AC-12 边界：落盘 JSON 不存储状态/累计字段（由记录推导）；重启后已完成单仍拒绝报工', (t) => {
  const dir = tmpWorkspace(t);
  run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  run(['report', 'WO-20261112-01', D1, '张三', '100', '0'], opts(dir));
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(data.orders.length, 1);
  assert.ok(!('status' in data.orders[0]), '状态不得落盘');
  assert.ok(!('okTotal' in data.orders[0]) && !('badTotal' in data.orders[0]), '累计数不得落盘');
  assert.ok(!('status' in data) && !('totals' in data), '顶层不得存储状态/合计');
  assert.equal(data.orders[0].reports.length, 1);
  // 重启后状态仍由记录正确推导
  const r = run(['report', 'WO-20261112-01', D2, '李四', '1', '0'], opts(dir));
  assert.equal(r.code, 1);
  assert.equal(r.err, '错误：工单已完工，拒绝报工：WO-20261112-01\n');
});

// ---------- AC-13 默认数据文件位置 ----------

test('AC-13 正常：默认运行目录生成 data.json 且包含该工单数据', (t) => {
  const dir = tmpWorkspace(t);
  const r = run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  assert.equal(r.code, 0);
  const file = path.join(dir, 'data.json');
  assert.equal(fs.existsSync(file), true);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].id, 'WO-20261112-01');
  assert.equal(data.orders[0].product, '支架');
  assert.equal(data.orders[0].planQty, 100);
  assert.equal(data.seq['20261112'], 1);
  // 不设覆盖变量时，后续命令默认读同一文件
  assert.match(run(['list'], opts(dir)).out, /WO-20261112-01/);
});

test('AC-13 正常（真实进程）：子进程 cwd 下生成 data.json，后续子进程默认读取同文件', (t) => {
  const dir = tmpWorkspace(t);
  const c1 = cli(['create', '轴承', '5'], dir);
  assert.equal(c1.status, 0, c1.stderr);
  const file = path.join(dir, 'data.json');
  assert.equal(fs.existsSync(file), true);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.orders[0].product, '轴承');
  const c2 = cli(['list'], dir);
  assert.equal(c2.status, 0);
  assert.match(c2.stdout, /WO-\d{8}-01 \| 轴承 \| 5 \| 0 \| 0 \| 0% \| 待开工/);
});

// ---------- AC-14 覆盖数据文件位置 ----------

test('AC-14 正常：WORKORDER_DATA_FILE 完全接管（写入 P、同 env 读回），默认 data.json 不被创建', (t) => {
  const dir = tmpWorkspace(t);
  const p = path.join(dir, 'custom', 'p.json');
  fs.mkdirSync(path.dirname(p));
  const env = { WORKORDER_DATA_FILE: p };
  const r1 = run(['create', '支架', '100'], { cwd: dir, env, now: NOW_D1 });
  assert.equal(r1.code, 0);
  assert.equal(fs.existsSync(p), true);
  assert.equal(fs.existsSync(path.join(dir, 'data.json')), false);
  run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], { cwd: dir, env });
  const q = run(['query', D1], { cwd: dir, env });
  assert.equal(q.code, 0);
  assert.deepEqual(lines(q.out), [`${D1} | WO-20261112-01 | 张三 | 30 | 2`]);
  const l = run(['list'], { cwd: dir, env });
  assert.match(l.out, /WO-20261112-01 \| 支架 \| 100 \| 30 \| 2 \| 30% \| 进行中/);
});

test('AC-14 边界：默认 data.json 已存在时其内容不被创建/修改；真实进程同 env 两进程读写一致', (t) => {
  const dir = tmpWorkspace(t);
  // 先在默认位置留下数据
  run(['create', '默认单', '7'], opts(dir, { now: NOW_D1 }));
  const defFile = path.join(dir, 'data.json');
  const defBefore = snapshot(defFile);
  // env 接管路径 P
  const p = path.join(dir, 'p.json');
  const env = { WORKORDER_DATA_FILE: p };
  const r = run(['create', '覆盖单', '9'], { cwd: dir, env, now: NOW_D1 });
  assert.equal(r.code, 0);
  assert.equal(snapshot(defFile), defBefore); // 默认文件字节不变
  assert.equal(fs.existsSync(p), true);
  assert.match(run(['list'], { cwd: dir, env }).out, /覆盖单/);
  assert.doesNotMatch(run(['list'], { cwd: dir, env }).out, /默认单/);
  // 真实进程：同 env 先写后读（两个独立进程）
  const dir2 = tmpWorkspace(t);
  const p2 = path.join(dir2, 'p.json');
  const env2 = { WORKORDER_DATA_FILE: p2 };
  const c1 = cli(['create', '支架', '100'], dir2, childEnv(env2));
  assert.equal(c1.status, 0, c1.stderr);
  assert.equal(fs.existsSync(path.join(dir2, 'data.json')), false);
  const c2 = cli(['report', c1.stdout.replace('已创建：', '').trim(), D1, '张三', '5', '0'], dir2, childEnv(env2));
  assert.equal(c2.status, 0, c2.stderr);
  const c3 = cli(['query', D1], dir2, childEnv(env2));
  assert.equal(c3.status, 0);
  assert.match(c3.stdout, new RegExp(`${D1} \\| WO-\\d{8}-01 \\| 张三 \\| 5 \\| 0`));
});

test('AC-14 异常：WORKORDER_DATA_FILE 指向不存在目录时应给出明确中文错误，而非未捕获异常（BUG-1 证据）', (t) => {
  const dir = tmpWorkspace(t);
  const badPath = path.join(dir, 'no-such-dir', 'p.json');
  let threw = null;
  let r = null;
  try {
    r = run(['create', '支架', '100'], { cwd: dir, env: { WORKORDER_DATA_FILE: badPath }, now: NOW_D1 });
  } catch (e) {
    threw = e;
  }
  // PRD FR-9：错误信息须明确说明原因、便于人与脚本读取；不应抛未捕获异常（真实进程下为英文堆栈）
  assert.ok(!threw, `run() 抛出未捕获异常：${threw && threw.message}`);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^错误：/);
});

// ---------- AC-15 空数据列表 ----------

test('AC-15 正常：空数据列表输出（暂无工单）、退出码 0、不创建数据文件', (t) => {
  const dir = tmpWorkspace(t);
  const l = run(['list'], opts(dir));
  assert.equal(l.code, 0);
  assert.equal(l.out, NO_ORDERS);
  assert.equal(l.err, '');
  assert.equal(fs.existsSync(path.join(dir, 'data.json')), false);
});

test('AC-15 边界：显式空 orders 的数据文件同样输出空提示且文件内容不变', (t) => {
  const dir = tmpWorkspace(t);
  const file = path.join(dir, 'data.json');
  const text = '{"version":1,"orders":[],"seq":{}}';
  fs.writeFileSync(file, text, 'utf8');
  const l = run(['list'], opts(dir));
  assert.equal(l.code, 0);
  assert.equal(l.out, NO_ORDERS);
  assert.equal(snapshot(file), text); // 只读命令不改写文件
});

// ---------- FR-8 补充边界（裁决 3：文件存在但内容损坏） ----------

test('FR-8 边界（裁决3）：0 字节/纯空白文件按损坏明确拒绝、不写回', (t) => {
  const dir = tmpWorkspace(t);
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '', 'utf8');
  let r = run(['list'], opts(dir));
  assert.equal(r.code, 1);
  assert.equal(r.err, `错误：数据文件已损坏，已拒绝读写：${file}（请人工处理后重试）\n`);
  fs.writeFileSync(file, '   \n  ', 'utf8');
  const before = snapshot(file);
  r = run(['create', '支架', '100'], opts(dir, { now: NOW_D1 }));
  assert.equal(r.code, 1);
  assert.match(r.err, /^错误：数据文件已损坏，已拒绝读写：/);
  assert.equal(snapshot(file), before); // 不覆盖、不重建
});
