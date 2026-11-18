'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { BridgeClient } = require('../src/backend');
const { copyRuntime, removeTemporary } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const project = path.resolve(desktop, '..');
const source = path.resolve(project, '..', 'tree');
const executable =
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe');
const files = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];

test('损坏输入不破坏当前会话；外部修改校正后拒绝覆盖', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(executable) || !fs.existsSync(path.join(source, 'Camera4.zip'))) {
    t.skip('需要构建后的后端和真实测试数据。');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-dataset-integrity-'));
  const runtime = path.join(temp, 'runtime');
  const data = path.join(temp, 'valid');
  const invalid = path.join(temp, 'invalid');
  fs.mkdirSync(data);
  fs.mkdirSync(invalid);
  for (const name of files) {
    fs.copyFileSync(path.join(source, name), path.join(data, name));
    fs.copyFileSync(path.join(source, name), path.join(invalid, name));
  }
  const client = new BridgeClient(copyRuntime(executable, runtime));
  try {
    const zip = path.join(source, 'Camera4.zip');
    const loaded = await client.call('load', { dataDir: data, zipPath: zip });
    const badZip = path.join(temp, 'bad.zip');
    fs.writeFileSync(badZip, 'not a zip');
    await assert.rejects(client.call('load', { dataDir: invalid, zipPath: badZip }));
    let state = await client.call('state');
    assert.equal(state.loaded, true, '损坏 ZIP 不应清空已有会话');
    assert.equal(state.dataDir, data);
    assert.equal(state.treeId, loaded.treeId);

    fs.writeFileSync(path.join(invalid, 'imgPosList.txt'), '1 1 0 invalid 0 0 0 0\n');
    await assert.rejects(client.call('load', { dataDir: invalid, zipPath: zip }));
    state = await client.call('state');
    assert.equal(state.loaded, true, '损坏位姿不应清空已有会话');
    assert.equal(state.dataDir, data);

    fs.copyFileSync(path.join(source, 'imgPosList.txt'), path.join(invalid, 'imgPosList.txt'));
    const treeFile = path.join(invalid, 'tree_centers2.txt');
    const treeBytes = fs.readFileSync(treeFile, 'utf8');
    const firstTree = treeBytes.split(/\r?\n/).find((line) => /^\s*\d+\s/.test(line));
    fs.appendFileSync(treeFile, `\n${firstTree}\n`);
    await assert.rejects(client.call('load', { dataDir: invalid, zipPath: zip }), /重复树号/);
    state = await client.call('state');
    assert.equal(state.loaded, true, '重复树号不应替换已有会话');
    assert.equal(state.dataDir, data);
    fs.writeFileSync(treeFile, treeBytes);

    const metaFile = path.join(invalid, 'Metashape.txt');
    const metaBytes = fs.readFileSync(metaFile, 'utf8');
    const firstFrame = metaBytes.split(/\r?\n/).find((line) => /^\s*\d.*\.jpg\s/i.test(line));
    fs.appendFileSync(metaFile, `\n${firstFrame}\n`);
    await assert.rejects(client.call('load', { dataDir: invalid, zipPath: zip }), /相机位姿.*重复/);
    state = await client.call('state');
    assert.equal(state.loaded, true, '重复相机位姿不应替换已有会话');
    assert.equal(state.dataDir, data);
    fs.writeFileSync(metaFile, metaBytes);

    const corruptMarks = path.join(invalid, 'manual_marks.csv');
    fs.writeFileSync(corruptMarks, '1,NaN,0\n');
    await assert.rejects(client.call('load', { dataDir: invalid, zipPath: zip }), /校正/);
    assert.equal(fs.readFileSync(corruptMarks, 'utf8'), '1,NaN,0\n');
    state = await client.call('state');
    assert.equal(state.loaded, true, '损坏的校正文件不应替换已有会话');
    assert.equal(state.dataDir, data);

    await client.call('mark.set', { x: 0.5, y: 0.55 });
    const marks = path.join(data, 'manual_marks.csv');
    fs.appendFileSync(marks, '# external edit\n');
    const externallyEdited = fs.readFileSync(marks);
    await assert.rejects(client.call('mark.save'), /校正.*变化|外部.*修改/);
    assert.deepEqual(fs.readFileSync(marks), externallyEdited, '不覆盖外部编辑');
    assert.equal((await client.call('state')).markDirty, true, '保存失败后保留未保存状态');
  } finally {
    const closed = client.child.exitCode === null ? once(client.child, 'close') : Promise.resolve();
    client.close();
    await closed;
    removeTemporary(temp, 'treeextract-dataset-integrity-');
  }
});
