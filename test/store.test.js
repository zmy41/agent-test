'use strict';

/** store.js 单元测试（设计 TASK-3，覆盖 FR-8 / AC-13 / AC-14 / 裁决 3） */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../store');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('resolveDataPath：无覆盖时取运行目录 data.json（AC-13）', () => {
  assert.equal(store.resolveDataPath('C:\\run', undefined), path.join('C:\\run', 'data.json'));
  assert.equal(store.resolveDataPath('C:\\run', {}), path.join('C:\\run', 'data.json'));
  assert.equal(
    store.resolveDataPath('C:\\run', { WORKORDER_DATA_FILE: '' }),
    path.join('C:\\run', 'data.json')
  );
});

test('resolveDataPath：WORKORDER_DATA_FILE 非空时完全接管（AC-14）', () => {
  assert.equal(
    store.resolveDataPath('C:\\run', { WORKORDER_DATA_FILE: 'D:\\else\\p.json' }),
    'D:\\else\\p.json'
  );
});

test('load：文件不存在 → 空数据启动（裁决 3）', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(store.load(path.join(dir, 'data.json')), {
    ok: true,
    data: { version: 1, orders: [], seq: {} },
  });
});

test('load：正常文件原样读出；save 落盘（缩进 2，UTF-8）后可读回（AC-12）', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  const data = {
    version: 1,
    orders: [
      {
        id: 'WO-20261112-01',
        product: '支架',
        planQty: 100,
        reports: [{ date: '2026-11-12', worker: '张三', okQty: 30, badQty: 2 }],
      },
    ],
    seq: { '20261112': 2 },
  };
  store.save(file, data);
  const loaded = store.load(file);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.data, data);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data, null, 2));
});

test('load：JSON.parse 失败 → 判为损坏，且绝不写回（裁决 3）', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{oops', 'utf8');
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(store.load(file), { ok: false, reason: '损坏' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('load：结构不符 → 判为损坏（根非对象/根为数组/orders 非数组/seq 非对象）', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  const badTexts = [
    '42',
    '"str"',
    'null',
    'true',
    '[]',
    JSON.stringify({ orders: {}, seq: {} }),
    JSON.stringify({ orders: 1, seq: {} }),
    JSON.stringify({ orders: [], seq: [] }),
    JSON.stringify({ orders: [], seq: null }),
    JSON.stringify({ orders: [], seq: 'x' }),
  ];
  for (const text of badTexts) {
    fs.writeFileSync(file, text, 'utf8');
    assert.deepEqual(store.load(file), { ok: false, reason: '损坏' }, text);
  }
});

test('load：结构合法即通过（不逐条校验记录字段，浅校验）', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, orders: [{ id: 'X' }], seq: {} }), 'utf8');
  const loaded = store.load(file);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.data, { version: 1, orders: [{ id: 'X' }], seq: {} });
});
