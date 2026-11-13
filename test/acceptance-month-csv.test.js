'use strict';

/**
 * 验收测试（docs/workorder-monthly-csv/02-design.md TASK-5）—— 按 01-prd AC-1 ~ AC-12 逐条端到端。
 *
 * 执行方式沿用既有 acceptance-*.test.js 约定：
 * 1) run() 注入（cwd / env / now）覆盖 AC-1 ~ AC-11（含 AC-11 既有 query/list 回归抽查）；
 * 2) AC-12 BOM 字节级校验：
 *    a) 真实 CLI 子进程（spawnSync encoding:'buffer'）取原始 stdout 字节验证首三字节 EF BB BF；
 *    b) 按设计 §5-3 口径将 run() 输出写临时 .csv 后回读首三字节与 UTF-8 内容（中文字段不乱码）。
 *
 * 约束遵守：仅新增本文件；框架仅用 node:test（node --test），真实进程用 node:child_process；
 * 零第三方依赖；不修改产品代码与既有测试文件；不删除/弱化既有断言。
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

const M1 = '2026-11'; // PRD 前置约定：M1/M2 为两个不同年月
const M2 = '2026-12';
const D1 = '2026-11-12'; // D1/D2 为 M1 内两个不同日期
const D2 = '2026-11-13';
const NOW_D1 = new Date(2026, 10, 12, 9, 0, 0);
const NOW_D2 = new Date(2026, 10, 13, 9, 0, 0);

const LIST_HEADER = '工单号 | 产品 | 计划 | 累计合格 | 累计不良 | 进度 | 状态';
const USAGE = '错误：用法不正确，子命令：create|report|list|detail|query\n'; // 旧文案不变（裁决 1）
const NO_MONTH = '（该月无报工记录）\n';
const BOM = '\uFEFF';
const CSV_HEADER = '日期,工单号,操作工,合格数量,不良数量';

function invalidYm(ym) {
  return `错误：年月无效，须为 YYYY-MM 且月份为 01-12：${ym}\n`;
}

// ---------- 通用辅助（与既有 acceptance 文件同风格，独立实现，不改既有文件） ----------

function tmpWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-accept-mc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function opts(dir, extra) {
  return { cwd: dir, env: {}, ...(extra || {}) };
}

function lines(out) {
  return out.split('\n').filter((s) => s !== '');
}

/** 构造真实子进程环境：继承宿主环境但剥离被测变量 */
function childEnv(extra) {
  const env = { ...process.env };
  delete env.WORKORDER_DATA_FILE;
  return Object.assign(env, extra || {});
}

/** 真实 CLI 子进程（字节模式）：返回原始 stdout Buffer，可做字节级断言 */
function cliBuffer(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: childEnv(),
    encoding: 'buffer',
    timeout: 60000,
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: r.stdout || Buffer.alloc(0),
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
  };
}

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

/** AC-1 承载数据：创建工单（计划 100），M1 内三笔：D1 张三 30/2、D2 李四 40/1、D1 王五 5/0 */
function ac1Workspace(t) {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', '支架', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D2, '李四', '40', '1'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '王五', '5', '0'], opts(dir)).code, 0);
  return dir;
}

/** AC-7 承载数据：操作工名含英文逗号与英文双引号 */
function ac7Workspace(t) {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', '支架', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '张三,李四', '10', '0'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '王"五"', '5', '0'], opts(dir)).code, 0);
  return dir;
}

// ---------- AC-1 月度合计正确 ----------

test('AC-1 月度合计：M1 三笔 → 笔数 3、合格 75、不良 3，退出码 0', (t) => {
  const dir = ac1Workspace(t);
  const r = run(['stat', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, '报工笔数：3\n合格总数：75\n不良总数：3\n');
});

// ---------- AC-2 跨工单汇总 ----------

test('AC-2 跨工单汇总：W1/W2 各一笔 → 笔数 2、合格 40、不良 2，不分工单展示', (t) => {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', 'W1产品', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['create', 'W2产品', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-02', D2, '李四', '10', '0'], opts(dir)).code, 0);
  const r = run(['stat', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, '报工笔数：2\n合格总数：40\n不良总数：2\n');
});

// ---------- AC-3 空月统计 ----------

test('AC-3 空月统计：M1 有一笔时统计 M2 → 空结果提示、退出码 0、无伪造数字', (t) => {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', '支架', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '张三', '30', '0'], opts(dir)).code, 0);
  const r = run(['stat', M2], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, NO_MONTH);
  assert.equal(r.err, '');
  assert.ok(!/\d/.test(r.out), '空月提示不得输出统计数字');
  // 空数据状态（无数据文件）统计同样为空提示
  const dir2 = tmpWorkspace(t);
  const r2 = run(['stat', M1], opts(dir2));
  assert.equal(r2.code, 0);
  assert.equal(r2.out, NO_MONTH);
});

// ---------- AC-4 非法月份拒绝（统计） ----------

test('AC-4 六类非法年月拒绝（统计）：每次报错、退出码非 0、stdout 无任何统计数字', (t) => {
  const dir = ac1Workspace(t);
  const file = path.join(dir, 'data.json');
  const before = fs.readFileSync(file, 'utf8');
  const cases = [
    [['stat', '2026-13'], invalidYm('2026-13')],
    [['stat', '2026-00'], invalidYm('2026-00')],
    [['stat', '2026-1'], invalidYm('2026-1')],
    [['stat', '202601'], invalidYm('202601')],
    [['stat', 'abc'], invalidYm('abc')],
    [['stat'], USAGE], // 缺省年月（不给年月）
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv)); // stdout 为空，即无任何统计数字
    assert.equal(r.err, message, JSON.stringify(argv));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before); // 只读命令：磁盘字节不变
});

// ---------- AC-5 月份隔离 ----------

test('AC-5 月份隔离：M1/M2 各一笔，分别统计互不混入（导出同样隔离）', (t) => {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', '支架', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '张三', '30', '0'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', '2026-12-20', '李四', '20', '0'], opts(dir)).code, 0);
  const s1 = run(['stat', M1], opts(dir));
  assert.equal(s1.out, '报工笔数：1\n合格总数：30\n不良总数：0\n');
  const s2 = run(['stat', M2], opts(dir));
  assert.equal(s2.out, '报工笔数：1\n合格总数：20\n不良总数：0\n');
  // 导出同口径：各月 CSV 仅含本月记录
  const e1 = parseCsv(run(['export', M1], opts(dir)).out.slice(1));
  assert.deepEqual(e1.slice(1).map((r) => r[2]), ['张三']);
  const e2 = parseCsv(run(['export', M2], opts(dir)).out.slice(1));
  assert.deepEqual(e2.slice(1).map((r) => r[2]), ['李四']);
});

// ---------- AC-6 CSV 表头、行数与行序 ----------

test('AC-6 导出 M1：表头五列、3 数据行、行序 D1张三→D1王五→D2李四、字段值含工单号一致', (t) => {
  const dir = ac1Workspace(t);
  const r = run(['export', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.ok(r.out.startsWith(BOM));
  const rows = parseCsv(r.out.slice(1)); // BOM 属编码标记非内容：先剥离再解析（设计 §8 风险2）
  assert.deepEqual(rows[0], ['日期', '工单号', '操作工', '合格数量', '不良数量']);
  assert.equal(rows.length, 4); // 1 表头 + 3 数据行
  assert.deepEqual(rows.slice(1), [
    [D1, 'WO-20261112-01', '张三', '30', '2'],
    [D1, 'WO-20261112-01', '王五', '5', '0'],
    [D2, 'WO-20261112-01', '李四', '40', '1'],
  ]);
});

// ---------- AC-7 CSV 特殊字符转义 ----------

test('AC-7 含逗号/双引号操作工：转义后解析仍每行 5 列、原值不变、无串列', (t) => {
  const dir = ac7Workspace(t);
  const r = run(['export', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  const rows = parseCsv(r.out.slice(1));
  assert.equal(rows.length, 3); // 表头 + 2 数据行
  for (const line of rows) assert.equal(line.length, 5); // 无串列
  assert.deepEqual(rows.slice(1), [
    [D1, 'WO-20261112-01', '张三,李四', '10', '0'],
    [D1, 'WO-20261112-01', '王"五"', '5', '0'],
  ]);
  // 原始转义形态：引号包裹 + 内部双引号双写
  assert.ok(r.out.includes('"张三,李四"'));
  assert.ok(r.out.includes('"王""五"""'));
});

// ---------- AC-8 空月导出 ----------

test('AC-8 空月导出：仅表头一行、无数据行、退出码 0', (t) => {
  const dir = ac1Workspace(t);
  const r = run(['export', M2], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.ok(r.out.startsWith(BOM));
  const rows = parseCsv(r.out.slice(1));
  assert.deepEqual(rows, [['日期', '工单号', '操作工', '合格数量', '不良数量']]);
});

// ---------- AC-9 非法月份拒绝（导出） ----------

test('AC-9 六类非法年月拒绝（导出）：报错、退出码非 0、stdout 无任何 CSV 内容（无表头无数据行）', (t) => {
  const dir = ac1Workspace(t);
  const cases = [
    [['export', '2026-13'], invalidYm('2026-13')],
    [['export', '2026-00'], invalidYm('2026-00')],
    [['export', '2026-1'], invalidYm('2026-1')],
    [['export', '202601'], invalidYm('202601')],
    [['export', 'abc'], invalidYm('abc')],
    [['export'], USAGE],
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv)); // 无 BOM、无表头、无数据行
    assert.equal(r.err, message, JSON.stringify(argv));
  }
});

// ---------- AC-10 导出内容纯净 ----------

test('AC-10 导出内容纯净：整体按 CSV 解析恰为 1 表头 + 3 数据行，无空行无提示语', (t) => {
  const dir = ac1Workspace(t);
  const r = run(['export', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, ''); // 成功时 stderr 必为空：除 CSV 外不含任何其它文字
  const csv = r.out.slice(1); // 剥离 BOM 后整体解析
  assert.equal(
    csv,
    [
      CSV_HEADER,
      `${D1},WO-20261112-01,张三,30,2`,
      `${D1},WO-20261112-01,王五,5,0`,
      `${D2},WO-20261112-01,李四,40,1`,
    ].join('\n') + '\n'
  );
  assert.ok(csv.endsWith('\n') && !csv.endsWith('\n\n')); // 除末尾换行外无空行
  assert.ok(!csv.includes('\n\n'));
  const rows = parseCsv(csv);
  assert.equal(rows.length, 4);
  for (const line of rows) assert.equal(line.length, 5); // 无多余列
});

// ---------- AC-11 既有功能不受影响（回归抽查） ----------

test('AC-11 回归抽查：既有 query D1 两笔（张三 30/2、王五 5/0，含工单号）与列表 75/3/75%/进行中', (t) => {
  const dir = ac1Workspace(t);
  const q = run(['query', D1], opts(dir));
  assert.equal(q.code, 0);
  assert.deepEqual(lines(q.out), [
    `${D1} | WO-20261112-01 | 张三 | 30 | 2`,
    `${D1} | WO-20261112-01 | 王五 | 5 | 0`,
  ]);
  const l = run(['list'], opts(dir));
  assert.equal(l.code, 0);
  assert.deepEqual(lines(l.out), [
    LIST_HEADER,
    'WO-20261112-01 | 支架 | 100 | 75 | 3 | 75% | 进行中',
  ]);
  // 既有用法错误文案不变（stat/export 接入后旧命令零改动）
  assert.equal(run(['nonsense'], opts(dir)).err, USAGE);
});

// ---------- AC-12 Excel 中文兼容（BOM 字节级，自动化部分） ----------

test('AC-12 BOM 字节级：真实 CLI stdout 首三字节 EF BB BF；写临时 .csv 回读字节与中文内容一致', (t) => {
  const dir = ac7Workspace(t);
  const expectedCsv =
    [CSV_HEADER, `${D1},WO-20261112-01,"张三,李四",10,0`, `${D1},WO-20261112-01,"王""五""",5,0`].join('\n') + '\n';

  // a) 真实 CLI 子进程：原始 stdout 字节（不经任何 shell 转码）
  const proc = cliBuffer(['export', M1], dir);
  assert.equal(proc.status, 0, `真实进程导出失败：${proc.stderr}`);
  assert.equal(proc.stderr, '');
  const buf = proc.stdout;
  assert.ok(buf.length > 3);
  assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf], 'stdout 首三字节应为 UTF-8 BOM（EF BB BF）');
  const text = buf.toString('utf8');
  assert.ok(text.startsWith(BOM));
  assert.equal(text.slice(1), expectedCsv);

  // b) 设计 §5-3 口径：run() 输出按 UTF-8 写临时 .csv，回读首三字节与内容一致
  const r = run(['export', M1], opts(dir));
  const file = path.join(dir, 'export-m1.csv');
  fs.writeFileSync(file, r.out, 'utf8');
  const bytes = fs.readFileSync(file);
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), r.out); // UTF-8 内容回读一致
  // 剥离 BOM 后解析：中文与特殊字符字段为原值（Excel 打开前自动剥离 BOM 的等价判定）
  const rows = parseCsv(bytes.toString('utf8').slice(1));
  assert.deepEqual(rows, [
    ['日期', '工单号', '操作工', '合格数量', '不良数量'],
    [D1, 'WO-20261112-01', '张三,李四', '10', '0'],
    [D1, 'WO-20261112-01', '王"五"', '5', '0'],
  ]);
});
