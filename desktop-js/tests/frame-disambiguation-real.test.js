'use strict';

// 只读默认全景 ZIP；树心、位姿及人工校正复制到临时目录，绝不保存校正。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { BridgeClient } = require('../src/backend');
const { copyRuntime, removeTemporary } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const source = path.resolve(desktop, '..', '..', 'tree');
const executable =
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe');
const names = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('默认数据 106/107 两种切换顺序均使用不同自动主帧', { timeout: 180000 }, async (t) => {
  const zip = path.join(source, 'Camera4.zip');
  if (
    !fs.existsSync(executable) ||
    !fs.existsSync(zip) ||
    names.some((name) => !fs.existsSync(path.join(source, name)))
  )
    return t.skip('需要构建后的后端和默认真实数据。');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-frame-real-'));
  const data = path.join(temporary, 'data');
  fs.mkdirSync(data);
  const before = Object.fromEntries(names.map((name) => [name, hash(path.join(source, name))]));
  const hasManual106 = /^\s*106\s*,/m.test(
    fs.readFileSync(path.join(source, 'manual_marks.csv'), 'utf8'),
  );
  const zipBefore = fs.statSync(zip);
  for (const name of names) fs.copyFileSync(path.join(source, name), path.join(data, name));
  const client = new BridgeClient(
    copyRuntime(executable, path.join(temporary, 'runtime'), { includeModel: false }),
  );
  try {
    for (const order of [
      [106, 107],
      [107, 106],
    ]) {
      await client.call('load', { dataDir: data, zipPath: zip }, 120000);
      await client.call('view.options', { frameStrategy: 'quality', dualFrame: true }, 120000);
      const selected = new Map();
      for (const index of order) {
        const state = await client.call('tree.select', { index }, 120000);
        assert.equal(state.treeId, index);
        assert.ok(state.frame && state.framePoseAvailable, `树 ${index} 需要有位姿的有效帧`);
        assert.ok((await client.call('images', {}, 120000)).photo, `树 ${index} 需要可显示的照片`);
        selected.set(index, state);
      }
      assert.notEqual(selected.get(106).frame, selected.get(107).frame, `选树顺序 ${order}`);
      for (const index of order) {
        const state = await client.call('tree.select', { index }, 120000);
        assert.equal(state.frame, selected.get(index).frame, '重复切换时保留各树的自动主帧');
      }
      if (hasManual106) {
        assert.equal(selected.get(106).dualFrameInfo.state, 'manual', '既有 106 人工校正保留');
        assert.match(selected.get(106).frameSelectionWarning, /已有人工校正.*核查红圈/);
      }
    }
    for (const name of names) {
      assert.equal(hash(path.join(source, name)), before[name], `不修改原始 ${name}`);
      assert.equal(hash(path.join(data, name)), before[name], `不写入隔离数据 ${name}`);
    }
    const zipAfter = fs.statSync(zip);
    assert.equal(zipAfter.size, zipBefore.size);
    assert.equal(zipAfter.mtimeMs, zipBefore.mtimeMs);
  } finally {
    const closed = client.child.exitCode === null ? once(client.child, 'close') : Promise.resolve();
    client.close();
    await closed;
    removeTemporary(temporary, 'treeextract-frame-real-');
  }
});
