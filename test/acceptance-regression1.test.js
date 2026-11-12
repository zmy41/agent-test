'use strict';

/**
 * 回归轮 1 测试（测试角色产出）—— 只测失败项 + 受影响的 AC，不改既有内容。
 *
 * 回归范围：
 * - 失败项 BUG-1：WORKORDER_DATA_FILE 指向不存在目录时 create/report 抛未捕获
 *   ENOENT 英文堆栈 → 验证修复（workorder.js 编排层 saveOr）且转绿；
 * - 受影响的 AC：AC-13（默认数据文件位置）、AC-14（覆盖数据文件位置）；
 * - FR-9 相关错误输出：单行「错误：」中文文案、无英文堆栈、无 ANSI、退出码 1。
 *
 * 约束遵守：仅新增本文件（命名以 acceptance 开头）；框架仅用 Node 内置
 * node:test（node --test 执行），真实进程冒烟用 node:child_process；零第三方
 * 依赖；不修改产品代码与既有测试文件，不删除/弱化既有用例。
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
const NOW_D1 = new Date(2026, 10, 12, 9, 0, 0);

const NO_RECORDS = '（无报工记录）\n';
const WRITE_FAIL_PREFIX = '错误：数据文件写入失败：';
const WRITE_FAIL_SUFFIX = '（请确认目录存在且可写后重试）';

// ---------- 通用辅助（与 test/acceptance.test.js 同风格，独立实现，不改既有文件） ----------

function tmpWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-regr1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function opts(dir, extra) {
  return { cwd: dir, env: {}, ...(extra || {}) };
}

/** 构造真实子进程环境：继承宿主环境但剥离被测变量（可再叠加覆盖项） */
function childEnv(extra) {
  const env = { ...process.env };
  delete env.WORKORDER_DATA_FILE;
  return Object.assign(env, extra || {});
}

/** 真实 CLI 子进程：每次调用都是一次独立进程 */
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

function snapshot(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function nonEmptyLines(text) {
  return text.split('\n').filter((s) => s !== '');
}

/** FR-9 断言：单行「错误：」中文文案，无英文堆栈痕迹、无 ANSI 转义序列 */
function assertPlainSingleLineError(text, label) {
  const ls = nonEmptyLines(text);
  assert.equal(ls.length, 1, `${label} 应为单行错误，实际 ${ls.length} 行：${JSON.stringify(text)}`);
  assert.match(ls[0], /^错误：/, `${label} 应以「错误：」开头`);
  for (const marker of ['Error:', 'ENOENT', 'EACCES', 'EPERM', '    at ', '\u001b']) {
    assert.ok(!text.includes(marker), `${label} 含堆栈/ANSI 痕迹「${marker}」，违反 FR-9`);
  }
}

// ---------- BUG-1（失败项复测）：run 注入路径 ----------

test('BUG-1 修复（run 注入）：create 在 env 指向不存在目录时返回明确中文错误，不再抛未捕获异常', (t) => {
  const dir = tmpWorkspace(t);
  const badPath = path.join(dir, 'no-such-dir', 'p.json');
  let threw = null;
  let r = null;
  try {
    r = run(['create', '支架', '100'], { cwd: dir, env: { WORKORDER_DATA_FILE: badPath }, now: NOW_D1 });
  } catch (e) {
    threw = e;
  }
  assert.ok(!threw, `run() 抛出未捕获异常：${threw && threw.message}`);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  // 修复轮 1 新增文案（02-design §4.1 修复轮 1 条目）：一行中文，含路径与人工处理指引
  assert.equal(r.err, `${WRITE_FAIL_PREFIX}${badPath}${WRITE_FAIL_SUFFIX}\n`);
  assertPlainSingleLineError(r.err, 'create 写盘失败 stderr');
  // 磁盘无任何变更：坏路径与其父目录均未被创建
  assert.equal(fs.existsSync(badPath), false);
  assert.equal(fs.existsSync(path.dirname(badPath)), false);
});

test('BUG-1 修复（run 注入）：report 的写盘失败路径同样返回明确中文错误且数据文件字节不变', (t) => {
  const dir = tmpWorkspace(t);
  const file = path.join(dir, 'data.json');
  // 先正常创建一单（成功路径），再把数据文件置为只读以触发 save 的 EPERM 写盘异常
  let cr = run(['create', '轴承', '50'], opts(dir, { now: NOW_D1 }));
  assert.equal(cr.code, 0, cr.err);
  const before = snapshot(file);
  fs.chmodSync(file, 0o444); // 只读属性触发 save 的 EPERM
  let r = null;
  let threw = null;
  try {
    r = run(['report', 'WO-20261112-01', D1, '张三', '5', '0'], opts(dir, { now: NOW_D1 }));
  } catch (e) {
    threw = e;
  }
  assert.ok(!threw, `run() 抛出未捕获异常：${threw && threw.message}`);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err, `${WRITE_FAIL_PREFIX}${file}${WRITE_FAIL_SUFFIX}\n`);
  assertPlainSingleLineError(r.err, 'report 写盘失败 stderr');
  assert.equal(snapshot(file), before, '写盘失败后数据文件字节级不变');
  fs.chmodSync(file, 0o644); // 清理：恢复可写后再交由 tmpWorkspace 钩子删除（after 钩子按注册顺序执行）
});

// ---------- BUG-1（失败项复测）：真实进程路径 ----------

test('BUG-1 修复（真实进程）：create 指向不存在目录 → 退出码 1、stdout 空、stderr 单行中文错误、无堆栈', (t) => {
  const dir = tmpWorkspace(t);
  const badPath = path.join(dir, 'no-such-sub', 'p.json');
  const c = cli(['create', '支架', '100'], dir, childEnv({ WORKORDER_DATA_FILE: badPath }));
  assert.equal(c.status, 1);
  assert.equal(c.stdout, '', '失败时 stdout 应为空');
  assertPlainSingleLineError(c.stderr, 'create 写盘失败 stderr');
  assert.equal(nonEmptyLines(c.stderr)[0], `${WRITE_FAIL_PREFIX}${badPath}${WRITE_FAIL_SUFFIX}`);
  assert.equal(fs.existsSync(badPath), false, '坏路径文件未被创建');
  assert.equal(fs.existsSync(path.dirname(badPath)), false, '父目录未被创建');
});

test('BUG-1 修复（真实进程）：写盘失败后无任何数据变更——同 env 再报工报工单不存在、查询空提示、默认 data.json 不被创建', (t) => {
  const dir = tmpWorkspace(t);
  const badPath = path.join(dir, 'no-such-sub', 'p.json');
  const env = childEnv({ WORKORDER_DATA_FILE: badPath });
  const c1 = cli(['create', '支架', '100'], dir, env);
  assert.equal(c1.status, 1, c1.stderr);
  // 内存变更（seq/order.push）未落盘：下一次进程重新 load 得空数据 → 工单不存在
  const c2 = cli(['report', 'WO-20261112-01', D1, '张三', '30', '2'], dir, env);
  assert.equal(c2.status, 1);
  assert.equal(c2.stderr.trim(), `错误：工单不存在：WO-20261112-01`);
  assert.equal(c2.stdout, '');
  // 只读命令不受影响（BUG-1 旁证路径保持）：空提示、退出码 0
  const c3 = cli(['query', D1], dir, env);
  assert.equal(c3.status, 0);
  assert.equal(c3.stdout, NO_RECORDS);
  assert.equal(c3.stderr, '');
  // 默认 data.json 全程不被创建
  assert.equal(fs.existsSync(path.join(dir, 'data.json')), false);
});

test('BUG-1 修复（真实进程）：report 写盘失败路径（只读数据文件触发）同样单行中文错误、文件字节不变', (t) => {
  const dir = tmpWorkspace(t);
  const file = path.join(dir, 'data.json');
  const env = childEnv({ WORKORDER_DATA_FILE: file });
  const cr = cli(['create', '轴承', '50'], dir, env);
  assert.equal(cr.status, 0, cr.stderr);
  const before = snapshot(file);
  fs.chmodSync(file, 0o444);
  const rp = cli(['report', 'WO-20261112-01', D1, '张三', '5', '0'], dir, env);
  assert.equal(rp.status, 1);
  assert.equal(rp.stdout, '');
  assertPlainSingleLineError(rp.stderr, 'report 写盘失败 stderr');
  assert.equal(nonEmptyLines(rp.stderr)[0], `${WRITE_FAIL_PREFIX}${file}${WRITE_FAIL_SUFFIX}`);
  assert.equal(snapshot(file), before, '写盘失败后数据文件字节级不变');
  fs.chmodSync(file, 0o644); // 清理：恢复可写后再交由 tmpWorkspace 钩子删除
});

// ---------- 受影响 AC 回归：AC-13 / AC-14（修复未引入行为变化） ----------

test('AC-13 回归（真实进程）：默认位置仍正常——运行目录生成含工单数据的 data.json', (t) => {
  const dir = tmpWorkspace(t);
  const c = cli(['create', '支架', '100'], dir);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^已创建：WO-\d{8}-01\n$/);
  const file = path.join(dir, 'data.json');
  assert.equal(fs.existsSync(file), true, '默认 data.json 应在运行目录生成');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].product, '支架');
  assert.equal(data.orders[0].planQty, 100);
});

test('AC-14 回归（真实进程）：覆盖路径仍正常——写 P、默认文件不创建、同 env 两次独立进程读写一致', (t) => {
  const dir = tmpWorkspace(t);
  const p = path.join(dir, 'custom', 'wo.json');
  fs.mkdirSync(path.dirname(p), { recursive: true }); // 覆盖路径 P 的父目录须存在（存在且可写）
  const env = childEnv({ WORKORDER_DATA_FILE: p });
  const c1 = cli(['create', '轴承', '50'], dir, env);
  assert.equal(c1.status, 0, c1.stderr);
  assert.equal(fs.existsSync(p), true, '数据应写入覆盖路径 P');
  assert.equal(fs.existsSync(path.join(dir, 'data.json')), false, '默认 data.json 不被创建');
  // 进程级"重启"：第二个独立进程以同一 env 读回
  const c2 = cli(['detail', 'WO-20261112-01'], dir, env);
  assert.equal(c2.status, 0, c2.stderr);
  assert.match(c2.stdout, /WO-\d{8}-01 \| 轴承 \| 50 \| 0 \| 0 \| 0% \| 待开工/);
  // 同 env 继续报工并按日查询（AC-14 的"以同一变量再次执行可读到"）
  const c3 = cli(['report', 'WO-20261112-01', D1, '张三', '10', '0'], dir, env);
  assert.equal(c3.status, 0, c3.stderr);
  const c4 = cli(['query', D1], dir, env);
  assert.equal(c4.status, 0, c4.stderr);
  assert.match(c4.stdout, new RegExp(`${D1} \\| WO-\\d{8}-01 \\| 张三 \\| 10 \\| 0`));
});

test('AC-14 边界回归（真实进程）：env 设置时既有默认 data.json 内容字节不变', (t) => {
  const dir = tmpWorkspace(t);
  const defaultFile = path.join(dir, 'data.json');
  const defaultText = '{"version":1,"orders":[],"seq":{}}';
  fs.writeFileSync(defaultFile, defaultText, 'utf8');
  const p = path.join(dir, 'custom', 'wo.json');
  fs.mkdirSync(path.dirname(p), { recursive: true }); // 覆盖路径 P 的父目录须存在（存在且可写）
  const c = cli(['create', '支架', '100'], dir, childEnv({ WORKORDER_DATA_FILE: p }));
  assert.equal(c.status, 0, c.stderr);
  assert.equal(snapshot(defaultFile), defaultText, '默认 data.json 内容字节不变');
  assert.equal(fs.existsSync(p), true);
});

// ---------- FR-9 回归：错误输出形态（纯文本、单行、无堆栈、退出码 1） ----------

test('FR-9 回归（run 注入 + 真实进程）：两类写盘失败的错误输出均为单行纯文本中文，退出码 1', (t) => {
  // run 注入：不存在目录
  const dir = tmpWorkspace(t);
  const badPath = path.join(dir, 'a', 'b', 'c.json');
  const r1 = run(['create', '支架', '100'], { cwd: dir, env: { WORKORDER_DATA_FILE: badPath }, now: NOW_D1 });
  assert.equal(r1.code, 1);
  assertPlainSingleLineError(r1.err, 'run 注入 ENOENT');

  // run 注入：只读文件（EPERM）
  const dir2 = tmpWorkspace(t);
  const file2 = path.join(dir2, 'data.json');
  run(['create', '轴承', '50'], opts(dir2, { now: NOW_D1 }));
  fs.chmodSync(file2, 0o444);
  const r2 = run(['create', '齿轮', '30'], opts(dir2, { now: NOW_D1 }));
  assert.equal(r2.code, 1);
  assertPlainSingleLineError(r2.err, 'run 注入 EPERM');

  // 真实进程：不存在目录
  const dir3 = tmpWorkspace(t);
  const bad3 = path.join(dir3, 'x', 'y.json');
  const c = cli(['create', '支架', '100'], dir3, childEnv({ WORKORDER_DATA_FILE: bad3 }));
  assert.equal(c.status, 1);
  assertPlainSingleLineError(c.stderr, '真实进程 ENOENT');

  fs.chmodSync(file2, 0o644); // 清理：恢复可写后再交由 tmpWorkspace 钩子删除
});
