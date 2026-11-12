'use strict';

/**
 * store.js —— 数据文件 I/O（设计 §4.2 / §4.3）
 * 数据为单个 JSON 文件；文件不存在 → 空数据启动；
 * 存在但解析/结构不符 → 判为损坏，绝不写回该文件（裁决 3）。
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE_NAME = 'data.json';

function emptyData() {
  return { version: 1, orders: [], seq: {} };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** env.WORKORDER_DATA_FILE 非空字符串 → 直接用该值；否则 path.join(cwd, 'data.json') */
function resolveDataPath(cwd, env) {
  const override =
    env && typeof env.WORKORDER_DATA_FILE === 'string' ? env.WORKORDER_DATA_FILE : '';
  if (override !== '') return override;
  return path.join(cwd, DATA_FILE_NAME);
}

/** 损坏判定（浅校验）：根须为普通对象、orders 须为数组、seq 须为对象 */
function isValidStructure(data) {
  return isPlainObject(data) && Array.isArray(data.orders) && isPlainObject(data.seq);
}

/**
 * 文件不存在     → { ok: true,  data: { version:1, orders:[], seq:{} } }（裁决 3：空数据启动）
 * 存在且解析通过 → { ok: true,  data }（data 为解析结果）
 * 存在但判为损坏 → { ok: false, reason: '损坏' }（绝不写回该文件）
 */
function load(filePath) {
  if (!fs.existsSync(filePath)) return { ok: true, data: emptyData() };
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: '损坏' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: '损坏' };
  }
  if (!isValidStructure(parsed)) return { ok: false, reason: '损坏' };
  return { ok: true, data: parsed };
}

/** fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')；由 run() 在全部校验通过后调用 */
function save(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { resolveDataPath, load, save };
