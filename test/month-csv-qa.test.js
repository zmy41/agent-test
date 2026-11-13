'use strict';

/**
 * 测试角色 QA 独立用例（docs/workorder-monthly-csv/01-prd.md AC-1 ~ AC-12）。
 *
 * 与开发自测文件（test/acceptance-month-csv.test.js 等）相互独立、不重复堆砌：
 * 每个 AC 一条独立用例 + 4 条"推测用例"（PRD 未明说，报告覆盖说明中标注 SP-n）：
 *   SP-1 资源缺失（AC-3/AC-8 关联）：数据文件路径不存在时 stat/export 的空月口径与只读性
 *   SP-2 异常次序（AC-2/AC-6 关联）：同日跨工单的 CSV 行序 = 工单创建顺序（设计 §5-2/风险3）
 *   SP-3 参数边界（AC-4/AC-9 关联）：多余位置参数与未知选项 → 旧用法错误（Q-4 无筛选的印证）
 *   SP-4 对抗输入（AC-7 关联）：操作工名含换行符 → CSV 转义后解析仍 5 列原值
 *
 * 约束遵守：仅新增本文件；node:test 零第三方依赖；不修改产品代码与任何既有测试文件。
 * 导出结果按设计 §5-3 用 cmd /c 原样字节重定向取文件（AC-10/AC-12）。
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

const M1 = '2026-11';
const M2 = '2026-12';
const D1 = '2026-11-12';
const D2 = '2026-11-13';
const NOW_D1 = new Date(2026, 10, 12, 9, 0, 0);
const NOW_DEC1 = new Date(2026, 11, 1, 9, 0, 0);

const USAGE = '错误：用法不正确，子命令：create|report|list|detail|query\n'; // 旧文案一字不变
const NO_MONTH = '（该月无报工记录）\n';
const BOM = '\uFEFF';
const CSV_HEADER = '日期,工单号,操作工,合格数量,不良数量';
const LIST_HEADER = '工单号 | 产品 | 计划 | 累计合格 | 累计不良 | 进度 | 状态';

function invYm(ym) {
  return `错误：年月无效，须为 YYYY-MM 且月份为 01-12：${ym}\n`;
}

// ---------- 通用辅助（独立实现，不改既有文件） ----------

function tmpWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-qa-mc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function opts(dir, extra) {
  return { cwd: dir, env: {}, ...(extra || {}) };
}

/** 真实子进程环境：继承宿主环境但剥离被测变量 */
function childEnv(extra) {
  const env = { ...process.env };
  delete env.WORKORDER_DATA_FILE;
  return Object.assign(env, extra || {});
}

/** 极简 RFC 4180 解析器（仅测试回验用）：支持引号包裹字段内的逗号/双引号/换行 */
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
      i += 1; // 本系统行分隔为 \n，防御性忽略 \r
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

/** AC-1 承载数据：工单（计划 100），M1 三笔：D1张三30/2、D2李四40/1、D1王五5/0 */
function ac1Workspace(t) {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', '支架', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D2, '李四', '40', '1'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '王五', '5', '0'], opts(dir)).code, 0);
  return dir;
}

/** AC-7/AC-12 承载数据：操作工名含英文逗号与英文双引号 */
function ac7Workspace(t) {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', '支架', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '张三,李四', '10', '0'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '王"五"', '5', '0'], opts(dir)).code, 0);
  return dir;
}

const AC1_CSV = [
  CSV_HEADER,
  `${D1},WO-20261112-01,张三,30,2`,
  `${D1},WO-20261112-01,王五,5,0`,
  `${D2},WO-20261112-01,李四,40,1`,
].join('\n') + '\n';

const AC7_CSV = [
  CSV_HEADER,
  `${D1},WO-20261112-01,"张三,李四",10,0`,
  `${D1},WO-20261112-01,"王""五""",5,0`,
].join('\n') + '\n';

/** 设计 §5-3 规定的导出取文件方式：cmd /c 原样字节重定向（cwd 相对路径避开引号歧义） */
function cmdRedirectExport(dir, yearMonth, outName) {
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `node workorder.js export ${yearMonth} > ${outName}`], {
    cwd: dir,
    env: childEnv(),
    encoding: 'buffer',
    timeout: 60000,
    windowsHide: true,
  });
}

/** cmd /c 以 cwd 为临时目录执行，需将产品三文件复制进去（只读复制，不改仓库文件） */
function copyCliInto(dir) {
  for (const f of ['workorder.js', 'logic.js', 'store.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
}

// ---------- AC-1 月度合计正确 ----------

test('QA AC-1 月度合计：M1 三笔 → 笔数3/合格75/不良3，退出码 0，stat 只读不改盘', (t) => {
  const dir = ac1Workspace(t);
  const file = path.join(dir, 'data.json');
  const before = fs.readFileSync(file, 'utf8');
  const r = run(['stat', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, '报工笔数：3\n合格总数：75\n不良总数：3\n');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'stat 只读：数据文件字节不变');
});

// ---------- AC-2 跨工单汇总 ----------

test('QA AC-2 跨工单汇总：W1/W2 各一笔 → 2/40/2，输出不出现工单号（不分工单展示）', (t) => {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', 'W1产品', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['create', 'W2产品', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '张三', '30', '2'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-02', D2, '李四', '10', '0'], opts(dir)).code, 0);
  const r = run(['stat', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, '报工笔数：2\n合格总数：40\n不良总数：2\n');
  assert.ok(!r.out.includes('WO-'), '月度合计不分工单展示，输出不得含工单号');
});

// ---------- AC-3 空月统计 ----------

test('QA AC-3 空月统计：M1 有报工时统计 M2 → 空提示、退出码 0、无数字、不报错', (t) => {
  const dir = ac1Workspace(t);
  const file = path.join(dir, 'data.json');
  const before = fs.readFileSync(file, 'utf8');
  const r = run(['stat', M2], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out, NO_MONTH);
  assert.equal(r.err, '');
  assert.ok(!/\d/.test(r.out), '空月提示不得输出任何统计数字');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

// ---------- AC-4 非法月份拒绝（统计） ----------

test('QA AC-4 六类非法年月（统计）：逐类明确报错、退出码 1、stdout 空、磁盘字节不变', (t) => {
  const dir = ac1Workspace(t);
  const file = path.join(dir, 'data.json');
  const before = fs.readFileSync(file, 'utf8');
  const cases = [
    [['stat', '2026-13'], invYm('2026-13')],
    [['stat', '2026-00'], invYm('2026-00')],
    [['stat', '2026-1'], invYm('2026-1')],
    [['stat', '202601'], invYm('202601')],
    [['stat', 'abc'], invYm('abc')],
    [['stat'], USAGE], // 缺省年月
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
    assert.equal(r.err, message, JSON.stringify(argv));
    assert.ok(!/\d/.test(r.out) && r.out === '', '不得输出任何统计数字');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

// ---------- AC-5 月份隔离 ----------

test('QA AC-5 月份隔离：按报工日期归集、与创建时间无关（双向），含超额不封顶', (t) => {
  const dir = tmpWorkspace(t);
  // W1 "11月创建" 但报工日期在 12 月；W2 "12月创建" 但报工日期在 11 月（含超额 120）
  assert.equal(run(['create', 'W1产品', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', '2026-12-20', '李四', '20', '0'], opts(dir)).code, 0);
  assert.equal(run(['create', 'W2产品', '100'], opts(dir, { now: NOW_DEC1 })).code, 0);
  assert.equal(run(['report', 'WO-20261201-01', D1, '张三', '30', '2'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261201-01', D2, '王五', '120', '0'], opts(dir)).code, 0);
  const s1 = run(['stat', M1], opts(dir));
  assert.equal(s1.code, 0);
  assert.equal(s1.out, '报工笔数：2\n合格总数：150\n不良总数：2\n', 'M1 仅含报工日期在 M1 的两笔（120 超额直加）');
  const s2 = run(['stat', M2], opts(dir));
  assert.equal(s2.code, 0);
  assert.equal(s2.out, '报工笔数：1\n合格总数：20\n不良总数：0\n', 'M2 仅含报工日期在 M2 的一笔');
});

// ---------- AC-6 CSV 表头、行数与行序 ----------

test('QA AC-6 导出 M1：BOM 前缀、表头五列、3 数据行、行序 D1张三→D1王五→D2李四', (t) => {
  const dir = ac1Workspace(t);
  const r = run(['export', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.ok(r.out.startsWith(BOM), '成功输出首字符应为 BOM');
  const rows = parseCsv(r.out.slice(1)); // BOM 为编码标记，剥离后整体解析
  assert.deepEqual(rows[0], ['日期', '工单号', '操作工', '合格数量', '不良数量']);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.slice(1), [
    [D1, 'WO-20261112-01', '张三', '30', '2'],
    [D1, 'WO-20261112-01', '王五', '5', '0'],
    [D2, 'WO-20261112-01', '李四', '40', '1'],
  ]);
});

// ---------- AC-7 CSV 特殊字符转义 ----------

test('QA AC-7 含逗号/双引号操作工：引号包裹+双写，解析回验 5 列原值、无串列', (t) => {
  const dir = ac7Workspace(t);
  const r = run(['export', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.out.slice(1), AC7_CSV, '转义形态：引号包裹且内部双引号双写');
  const rows = parseCsv(r.out.slice(1));
  assert.equal(rows.length, 3);
  for (const line of rows) assert.equal(line.length, 5, '无串列');
  assert.deepEqual(rows.slice(1), [
    [D1, 'WO-20261112-01', '张三,李四', '10', '0'],
    [D1, 'WO-20261112-01', '王"五"', '5', '0'],
  ]);
});

// ---------- AC-8 空月导出 ----------

test('QA AC-8 空月导出：BOM + 仅表头一行、无数据行、退出码 0', (t) => {
  const dir = ac1Workspace(t);
  const r = run(['export', M2], opts(dir));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, BOM + `${CSV_HEADER}\n`);
});

// ---------- AC-9 非法月份拒绝（导出） ----------

test('QA AC-9 六类非法年月（导出）：退出码 1、stdout 空（无 BOM/表头/数据行）、磁盘不变', (t) => {
  const dir = ac1Workspace(t);
  const file = path.join(dir, 'data.json');
  const before = fs.readFileSync(file, 'utf8');
  const cases = [
    [['export', '2026-13'], invYm('2026-13')],
    [['export', '2026-00'], invYm('2026-00')],
    [['export', '2026-1'], invYm('2026-1')],
    [['export', '202601'], invYm('202601')],
    [['export', 'abc'], invYm('abc')],
    [['export'], USAGE],
  ];
  for (const [argv, message] of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
    assert.equal(r.err, message, JSON.stringify(argv));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

// ---------- AC-10 导出内容纯净（真实进程 + 设计 §5-3 cmd /c 取文件） ----------

test('QA AC-10 内容纯净（cmd /c 重定向）：文件整体解析恰 1 表头+3 数据行、无提示语、无 CRLF、退出码 0', (t) => {
  const dir = ac1Workspace(t);
  copyCliInto(dir);
  const outName = 'qa-ac10.csv';
  const c = cmdRedirectExport(dir, M1, outName);
  assert.equal(c.status, 0, 'cmd /c 透传子进程退出码应为 0');
  const file = path.join(dir, outName);
  assert.equal(fs.existsSync(file), true, '重定向文件已生成');
  const bytes = fs.readFileSync(file);
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], '首三字节为 UTF-8 BOM');
  assert.ok(!bytes.includes(0x0d), '输出不得含 CR（无 CRLF 混入）');
  const csv = bytes.toString('utf8').slice(1);
  assert.equal(csv, AC1_CSV, '除 BOM 外恰为纯 CSV 文本：无提示语、无空行、末尾恰一个换行');
  const rows = parseCsv(csv);
  assert.equal(rows.length, 4);
  for (const line of rows) assert.equal(line.length, 5);
});

// ---------- AC-11 既有功能回归抽查 ----------

test('QA AC-11 既有 query/list/detail/用法错误不受影响：D1 两笔、列表 75/3/75%/进行中', (t) => {
  const dir = ac1Workspace(t);
  const q = run(['query', D1], opts(dir));
  assert.equal(q.code, 0);
  assert.equal(q.out, `${D1} | WO-20261112-01 | 张三 | 30 | 2\n${D1} | WO-20261112-01 | 王五 | 5 | 0\n`);
  const l = run(['list'], opts(dir));
  assert.equal(l.code, 0);
  assert.equal(l.out, `${LIST_HEADER}\nWO-20261112-01 | 支架 | 100 | 75 | 3 | 75% | 进行中\n`);
  const d = run(['detail', 'WO-20261112-01'], opts(dir));
  assert.equal(d.code, 0);
  assert.deepEqual(d.out.split('\n').filter((s) => s !== ''), [
    'WO-20261112-01 | 支架 | 100 | 75 | 3 | 75% | 进行中',
    `${D1} | 张三 | 30 | 2`,
    `${D1} | 王五 | 5 | 0`,
    `${D2} | 李四 | 40 | 1`,
  ]);
  // 既有用法错误旧文案一字不变（stat/export 接入后未知命令仍为旧字符串）
  const u = run(['nonsense'], opts(dir));
  assert.equal(u.code, 1);
  assert.equal(u.out, '');
  assert.equal(u.err, USAGE);
});

// ---------- AC-12 Excel 中文兼容（自动化部分：BOM 字节级 + §5-3 取文件） ----------

test('QA AC-12 BOM/中文（真实进程 + cmd /c 取文件）：EF BB BF、UTF-8 中文回读一致、无乱码', (t) => {
  const dir = ac7Workspace(t);

  // a) 真实 CLI 子进程原始 stdout 字节（不经 shell 转码）
  const proc = spawnSync(process.execPath, [CLI, 'export', M1], {
    cwd: dir,
    env: childEnv(),
    encoding: 'buffer',
    timeout: 60000,
    windowsHide: true,
  });
  assert.equal(proc.status, 0, proc.stderr ? proc.stderr.toString('utf8') : '');
  const buf = proc.stdout;
  assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf], 'stdout 首三字节为 UTF-8 BOM');
  assert.equal(buf.toString('utf8').slice(1), AC7_CSV, 'UTF-8 回读与期望 CSV 一致（中文/特殊字符无失真）');

  // b) 设计 §5-3 规定方式：cmd /c 原样字节重定向存文件后回读
  copyCliInto(dir);
  const outName = 'qa-ac12.csv';
  const c = cmdRedirectExport(dir, M1, outName);
  assert.equal(c.status, 0);
  const bytes = fs.readFileSync(path.join(dir, outName));
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf]);
  const rows = parseCsv(bytes.toString('utf8').slice(1));
  assert.deepEqual(rows.slice(1), [
    [D1, 'WO-20261112-01', '张三,李四', '10', '0'],
    [D1, 'WO-20261112-01', '王"五"', '5', '0'],
  ]);
});

// ---------- 推测用例（PRD 未明说，见报告覆盖说明） ----------

test('QA SP-1 推测·资源缺失（AC-3/AC-8 关联）：数据文件路径不存在 → 空月口径退出码 0，不创建目录/文件', (t) => {
  const dir = tmpWorkspace(t);
  const missing = path.join(dir, 'no-such-dir', 'x.json');
  const s = run(['stat', M1], opts(dir, { env: { WORKORDER_DATA_FILE: missing } }));
  assert.equal(s.code, 0);
  assert.equal(s.out, NO_MONTH);
  const e = run(['export', M1], opts(dir, { env: { WORKORDER_DATA_FILE: missing } }));
  assert.equal(e.code, 0);
  assert.equal(e.out, BOM + `${CSV_HEADER}\n`);
  assert.equal(fs.existsSync(path.join(dir, 'no-such-dir')), false, '只读命令不得创建缺失目录');
  assert.equal(fs.existsSync(missing), false, '只读命令不得创建数据文件');
});

test('QA SP-2 推测·异常次序（AC-2/AC-6 关联）：同日跨工单 CSV 行序 = 工单创建顺序（先 W1 后 W2）', (t) => {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', 'W1产品', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['create', 'W2产品', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  // 录入次序故意与创建次序相反：先报 W2，再报 W1（同日）
  assert.equal(run(['report', 'WO-20261112-02', D1, '乙', '20', '0'], opts(dir)).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '甲', '30', '0'], opts(dir)).code, 0);
  const r = run(['export', M1], opts(dir));
  const rows = parseCsv(r.out.slice(1));
  assert.deepEqual(rows.slice(1), [
    [D1, 'WO-20261112-01', '甲', '30', '0'],
    [D1, 'WO-20261112-02', '乙', '20', '0'],
  ], '同日跨工单按工单创建顺序（设计 §5-2 口径）');
  const s = run(['stat', M1], opts(dir));
  assert.equal(s.out, '报工笔数：2\n合格总数：50\n不良总数：0\n');
});

test('QA SP-3 推测·参数边界（AC-4/AC-9 关联）：多余参数与未知选项 → 旧用法错误、stdout 空', (t) => {
  const dir = ac1Workspace(t);
  const cases = [
    ['stat', '2026-11', 'extra'],
    ['export', '2026-11', '--wo', 'WO-20261112-01'],
    ['stat', '--worker', '张三'],
  ];
  for (const argv of cases) {
    const r = run(argv, opts(dir));
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
    assert.equal(r.err, USAGE, JSON.stringify(argv));
  }
});

test('QA SP-4 推测·对抗输入（AC-7 关联）：操作工名含换行符 → 转义后解析仍 5 列原值', (t) => {
  const dir = tmpWorkspace(t);
  assert.equal(run(['create', '支架', '100'], opts(dir, { now: NOW_D1 })).code, 0);
  assert.equal(run(['report', 'WO-20261112-01', D1, '张\n三', '5', '0'], opts(dir)).code, 0);
  const s = run(['stat', M1], opts(dir));
  assert.equal(s.out, '报工笔数：1\n合格总数：5\n不良总数：0\n');
  const r = run(['export', M1], opts(dir));
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('"张\n三"'), '含换行字段按通用规则引号包裹');
  const rows = parseCsv(r.out.slice(1));
  assert.deepEqual(rows, [
    ['日期', '工单号', '操作工', '合格数量', '不良数量'],
    [D1, 'WO-20261112-01', '张\n三', '5', '0'],
  ]);
});
