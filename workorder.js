'use strict';

/**
 * workorder.js —— CLI 入口（设计 §4.1 / §4.5 / §5）
 * 一次性命令模型：parseArgs → load → 校验（全过才动数据）→ 变更内存 data → save → 输出。
 * list/detail/query/stat/export 为只读命令，不写盘；create/report 校验全部通过后才 save。
 */

const { resolveDataPath, load, save } = require('./store');
const logic = require('./logic');

const USAGE_ERROR = '错误：用法不正确，子命令：create|report|list|detail|query';
const CORRUPT_PREFIX = '错误：数据文件已损坏，已拒绝读写：';
const CORRUPT_SUFFIX = '（请人工处理后重试）';

// 各子命令的位置参数个数与允许的选项；其余 '--x' 选项视为未知选项 → 用法错误
const COMMAND_SPECS = {
  create: { positional: 2, flags: [] },
  report: { positional: 5, flags: [] },
  list: { positional: 0, flags: [] },
  detail: { positional: 1, flags: [] },
  query: { positional: 1, flags: ['wo', 'worker'] },
  stat: { positional: 1, flags: [] },
  export: { positional: 1, flags: [] },
};

const LIST_HEADER = '工单号 | 产品 | 计划 | 累计合格 | 累计不良 | 进度 | 状态';
const NO_ORDERS_HINT = '（暂无工单）';
const NO_RECORDS_HINT = '（无报工记录）';
// 本期新增（docs/workorder-monthly-csv/02-design.md §4.3）；USAGE_ERROR 等既有常量不变
const NO_MONTH_RECORDS_HINT = '（该月无报工记录）';
const INVALID_YM_PREFIX = '错误：年月无效，须为 YYYY-MM 且月份为 01-12：';

/**
 * argv 为去掉 node 与脚本名的参数数组
 * -> { cmd, positional:[], flags:{} } | { error: message }
 * 规则：首 token 为子命令；'--' 开头 token 取下一 token 为值（缺值 → error）；其余按序入 positional
 */
function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { error: USAGE_ERROR };
  const cmd = argv[0];
  const spec = COMMAND_SPECS[cmd];
  if (!spec) return { error: USAGE_ERROR };
  const positional = [];
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token === 'string' && token.startsWith('--')) {
      const name = token.slice(2);
      if (!spec.flags.includes(name)) return { error: USAGE_ERROR };
      if (i + 1 >= argv.length) return { error: USAGE_ERROR };
      flags[name] = argv[i + 1];
      i += 1;
    } else {
      positional.push(token);
    }
  }
  if (positional.length !== spec.positional) return { error: USAGE_ERROR };
  return { cmd, positional, flags };
}

function fail(message) {
  return { code: 1, out: '', err: `${message}\n` };
}

/**
 * save 失败（如 WORKORDER_DATA_FILE 指向不存在的目录、无写权限）不抛未捕获异常，
 * 统一转换为明确中文错误（FR-9；测试报告 BUG-1 修复）。写盘失败时磁盘必然无变更。
 */
function saveOr(data, filePath) {
  try {
    save(filePath, data);
    return null;
  } catch (err) {
    return fail(`错误：数据文件写入失败：${filePath}（请确认目录存在且可写后重试）`);
  }
}

function succeed(out) {
  return { code: 0, out, err: '' };
}

/** list/detail 共用的工单聚合行（进度 = Σ合格/计划 四舍五入，不封顶，裁决 1） */
function orderRow(order) {
  const t = logic.totals(order);
  const progress = `${Math.round((t.okQty / order.planQty) * 100)}%`;
  return [
    order.id,
    order.product,
    order.planQty,
    t.okQty,
    t.badQty,
    progress,
    logic.computeStatus(order),
  ].join(' | ');
}

function doCreate(data, filePath, positional, now) {
  const [name, planStr] = positional;
  const validated = logic.validateCreate(name, planStr);
  if (!validated.ok) return fail(validated.message);
  const dateKey = logic.formatDateKey(now);
  data.seq[dateKey] = (data.seq[dateKey] || 0) + 1;
  const id = logic.generateOrderId(dateKey, data.seq[dateKey]);
  data.orders.push(logic.makeOrder(id, validated.product, validated.planQty));
  const saveFailed = saveOr(data, filePath);
  if (saveFailed) return saveFailed;
  return succeed(`已创建：${id}\n`);
}

function doReport(data, filePath, positional) {
  const [id, dateStr, worker, okStr, badStr] = positional;
  // 报工校验顺序（设计 §5-2，首个失败即返回）：
  // 工单存在 → 未完工 → 操作工非空 → 日期合法 → 合格数 → 不良数 → 不同时为 0
  const order = logic.findOrder(data, id);
  if (!order) return fail(`错误：工单不存在：${id}`);
  if (logic.computeStatus(order) === logic.STATUS.DONE) {
    return fail(`错误：工单已完工，拒绝报工：${id}`);
  }
  if (typeof worker !== 'string' || worker.trim() === '') return fail('错误：操作工不能为空');
  if (!logic.isValidDateStr(dateStr)) {
    return fail(`错误：报工日期无效，须为 YYYY-MM-DD 的有效日历日期：${dateStr}`);
  }
  const okQty = logic.parseQty(okStr);
  if (okQty.kind === 'neg') return fail('错误：合格数量不能为负数');
  if (okQty.kind === 'nonInt') return fail('错误：合格数量必须为不小于 0 的整数');
  const badQty = logic.parseQty(badStr);
  if (badQty.kind === 'neg') return fail('错误：不良数量不能为负数');
  if (badQty.kind === 'nonInt') return fail('错误：不良数量必须为不小于 0 的整数');
  if (okQty.value === 0 && badQty.value === 0) return fail('错误：合格数与不良数不得同时为 0');

  order.reports.push({ date: dateStr, worker, okQty: okQty.value, badQty: badQty.value });
  const saveFailed = saveOr(data, filePath);
  if (saveFailed) return saveFailed;
  const t = logic.totals(order);
  const status = logic.computeStatus(order);
  return succeed(`报工成功：${id}（累计合格 ${t.okQty}，累计不良 ${t.badQty}，状态：${status}）\n`);
}

function doList(data) {
  if (data.orders.length === 0) return succeed(`${NO_ORDERS_HINT}\n`);
  const lines = [LIST_HEADER, ...data.orders.map(orderRow)];
  return succeed(`${lines.join('\n')}\n`);
}

function doDetail(data, id) {
  const order = logic.findOrder(data, id);
  if (!order) return fail(`错误：工单不存在：${id}`);
  const lines = [orderRow(order)];
  if (order.reports.length === 0) {
    lines.push(NO_RECORDS_HINT);
  } else {
    for (const report of logic.sortDetailReports(order.reports)) {
      lines.push(`${report.date} | ${report.worker} | ${report.okQty} | ${report.badQty}`);
    }
  }
  return succeed(`${lines.join('\n')}\n`);
}

function doQuery(data, dateStr, flags) {
  if (!logic.isValidDateStr(dateStr)) {
    return fail(`错误：报工日期无效，须为 YYYY-MM-DD 的有效日历日期：${dateStr}`);
  }
  const rows = logic.queryReports(data, dateStr, { wo: flags.wo, worker: flags.worker });
  if (rows.length === 0) return succeed(`${NO_RECORDS_HINT}\n`);
  const lines = rows.map((r) => `${r.date} | ${r.orderId} | ${r.worker} | ${r.okQty} | ${r.badQty}`);
  return succeed(`${lines.join('\n')}\n`);
}

/** stat：月度合计（只读；有数据恰三行，空月输出提示不报错，Q-5） */
function doStat(data, yearMonth) {
  if (!logic.isValidYearMonthStr(yearMonth)) {
    return fail(`${INVALID_YM_PREFIX}${yearMonth}`);
  }
  const rows = logic.queryMonthReports(data, yearMonth);
  if (rows.length === 0) return succeed(`${NO_MONTH_RECORDS_HINT}\n`);
  const t = logic.summarizeMonth(rows);
  return succeed(`报工笔数：${t.count}\n合格总数：${t.okQty}\n不良总数：${t.badQty}\n`);
}

/** export：月度明细 CSV（只读；成功 out = '\uFEFF' + CSV、err 恒为 ''，失败无残缺 CSV） */
function doExport(data, yearMonth) {
  if (!logic.isValidYearMonthStr(yearMonth)) {
    return fail(`${INVALID_YM_PREFIX}${yearMonth}`);
  }
  const rows = logic.queryMonthReports(data, yearMonth);
  return succeed(`\uFEFF${logic.toCsv(rows)}`);
}

/**
 * 可测入口 -> { code: 0|1, out: string, err: string }
 * out/err 非空时均以单个换行结尾，可直接写流。
 * opts: { cwd?, env?, now?: Date }，缺省分别取 process.cwd() / process.env / new Date()
 */
function run(argv, opts = {}) {
  const cwd = opts.cwd !== undefined ? opts.cwd : process.cwd();
  const env = opts.env !== undefined ? opts.env : process.env;
  const now = opts.now !== undefined ? opts.now : new Date();

  const parsed = parseArgs(argv);
  if (parsed.error) return fail(parsed.error);

  const filePath = resolveDataPath(cwd, env);
  const loaded = load(filePath);
  if (!loaded.ok) {
    return fail(`${CORRUPT_PREFIX}${filePath}${CORRUPT_SUFFIX}`);
  }
  const data = loaded.data;

  switch (parsed.cmd) {
    case 'create':
      return doCreate(data, filePath, parsed.positional, now);
    case 'report':
      return doReport(data, filePath, parsed.positional);
    case 'list':
      return doList(data);
    case 'detail':
      return doDetail(data, parsed.positional[0]);
    case 'query':
      return doQuery(data, parsed.positional[0], parsed.flags);
    case 'stat':
      return doStat(data, parsed.positional[0]);
    case 'export':
      return doExport(data, parsed.positional[0]);
    default:
      return fail(USAGE_ERROR);
  }
}

if (require.main === module) {
  const r = run(process.argv.slice(2));
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  process.exit(r.code);
}

module.exports = { parseArgs, run };
