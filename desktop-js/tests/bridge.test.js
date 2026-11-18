'use strict';

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
const project = path.resolve(desktop, '..');
const sourceData = path.resolve(project, '..', 'tree');
const executable =
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createIsolatedClient(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract bridge runtime '));
  let client;
  try {
    client = new BridgeClient(copyRuntime(executable, directory));
  } catch (error) {
    removeTemporary(directory, 'treeextract bridge runtime ');
    throw error;
  }
  t.after(async () => {
    const closed =
      client.child.exitCode === null && client.child.signalCode === null
        ? once(client.child, 'close')
        : Promise.resolve();
    client.close();
    await closed;
    removeTemporary(directory, 'treeextract bridge runtime ');
  });
  return client;
}

test(
  'bridge preserves real data while supporting the desktop workflow',
  { timeout: 180000 },
  async (t) => {
    if (!fs.existsSync(executable) || !fs.existsSync(path.join(sourceData, 'Camera4.zip'))) {
      t.skip(
        'Build the bridge and provide the sample panorama before running this integration test.',
      );
      return;
    }
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-js-'));
    const files = [
      'tree_centers2.txt',
      'Metashape.txt',
      'imgPosList.txt',
      'crown.csv',
      'trunk.csv',
      'manual_marks.csv',
    ];
    for (const name of files)
      fs.copyFileSync(path.join(sourceData, name), path.join(isolated, name));
    const originalMarks = sha256(path.join(sourceData, 'manual_marks.csv'));
    const client = createIsolatedClient(t);

    const defaults = await client.call('defaults');
    assert.ok(defaults.dataDir);
    const emptySnapshot = await client.call('photo.snapshot');
    assert.equal(emptySnapshot.photoClean, null);
    assert.equal(emptySnapshot.photoMarked, null);
    assert.equal(emptySnapshot.photoMarkNormalized, null);
    assert.equal(emptySnapshot.width, null);
    assert.equal(emptySnapshot.height, null);
    assert.equal(emptySnapshot.peopleDetection.status, 'unavailable');
    assert.equal(emptySnapshot.peopleDetection.personDetected, null);
    assert.equal(emptySnapshot.peopleDetection.headDetected, null);
    assert.equal(emptySnapshot.peopleDetection.scalpDetected, null);
    await assert.rejects(client.call('mark.set', { x: 0.5, y: 0.5 }), /没有可调整/);
    const loaded = await client.call('load', {
      dataDir: isolated,
      zipPath: path.join(sourceData, 'Camera4.zip'),
    });
    assert.equal(loaded.loaded, true);
    assert.equal(loaded.treeCount, 228);
    assert.ok(loaded.frame);
    const trees = await client.call('trees');
    assert.equal(trees.length, 228);
    const images = await client.call('images');
    for (const key of ['panorama', 'photo', 'crop'])
      assert.match(images[key], /^data:image\/jpeg;base64,/);
    const snapshot = await client.call('photo.snapshot');
    assert.equal(snapshot.treeId, loaded.treeId);
    assert.equal(snapshot.frame, loaded.frame);
    assert.equal(snapshot.photoMarked, images.photo);
    assert.match(snapshot.photoClean, /^data:image\/jpeg;base64,/);
    assert.notEqual(snapshot.photoClean, snapshot.photoMarked);
    assert.equal(snapshot.width * 3, snapshot.height * 4);
    assert.deepEqual(snapshot.photoMarkNormalized, loaded.photoMarkNormalized);
    assert.equal(snapshot.peopleDetection.status, 'complete');
    assert.equal(typeof snapshot.peopleDetection.personDetected, 'boolean');
    assert.equal(typeof snapshot.peopleDetection.headDetected, 'boolean');
    assert.equal(snapshot.peopleDetection.scalpDetected, null);
    assert.equal(snapshot.peopleDetection.modelSha256.length, 64);

    const nearest = await client.call('tree.nearest');
    assert.equal(nearest.frame, loaded.frame);
    assert.equal(nearest.autoFrame, false);
    const oldMode = await client.call('view.options', { lowDistortion: false });
    assert.equal(oldMode.lowDistortion, false);
    const newMode = await client.call('view.options', { lowDistortion: true });
    assert.equal(newMode.lowDistortion, true);
    const manualTarget = await client.call('view.options', { bearing: 55.25 });
    assert.equal(manualTarget.autoFrame, false);
    assert.equal(manualTarget.bearing, 55.25);
    const manualView = await client.call('view.options', { viewPan: 120.5 });
    assert.equal(manualView.lockView, false);
    assert.equal(manualView.viewPan, 120.5);

    const changed = await client.call('mark.set', { x: 0.5, y: 0.6 });
    assert.equal(changed.markDirty, true);
    const corrected = await client.call('photo.snapshot');
    assert.ok(Math.abs(corrected.photoMarkNormalized.x - 0.5) < 1e-6);
    assert.ok(Math.abs(corrected.photoMarkNormalized.y - 0.6) < 1e-6);
    assert.equal(corrected.photoMarkNormalized.inFrame, true);
    assert.deepEqual(corrected.photoMarkNormalized, changed.photoMarkNormalized);
    await assert.rejects(client.call('load', { dataDir: isolated }), /未保存/);
    const saved = await client.call('mark.save');
    assert.equal(saved.markDirty, false);
    const panoMark = await client.call('mark.setPano', { x: 0.5, y: 0.5 });
    assert.equal(panoMark.markDirty, true);
    assert.equal(panoMark.lockView, false);
    assert.equal((await client.call('mark.save')).markDirty, false);
    assert.equal(sha256(path.join(sourceData, 'manual_marks.csv')), originalMarks);

    const recognition = await client.call('recognize');
    assert.ok(recognition.name);
    assert.equal(typeof recognition.reliable, 'boolean');
    assert.match((await client.call('images')).heat, /^data:image\/jpeg;base64,/);
    const nextTree = nearest.treeIndex === 1 ? 2 : 1;
    const nextState = await client.call('tree.select', { index: nextTree });
    assert.equal(nextState.recognition, '');
    assert.equal((await client.call('images')).heat, null);
    const rows = await client.call('table.build');
    assert.equal(rows.length, 228);
    const csv = path.join(isolated, 'table.csv');
    const xlsx = path.join(isolated, 'table.xlsx');
    await client.call('table.export', { path: csv, format: 'csv' });
    await client.call('table.export', { path: xlsx, format: 'xlsx' });
    assert.ok(fs.statSync(csv).size > 100);
    assert.equal(fs.readFileSync(xlsx).subarray(0, 2).toString('ascii'), 'PK');
    const selected = await client.call('table.select', { id: rows[0].id });
    assert.equal(selected.treeId, rows[0].id);

    // 双帧结果上拖出的红圈，转为人工优先并保存/重载后不能改变世界方向。
    await client.call('view.options', { autoFrame: true, dualFrame: true });
    const beforeManual = await client.call('tree.select', { index: 1 });
    assert.ok(['success', 'fallback'].includes(beforeManual.dualFrameInfo.state));
    const manual = await client.call('mark.set', { x: 0.5, y: 0.55 });
    assert.equal(manual.markDirty, true);
    const recomputed = await client.call('view.options', { viewFov: 75 });
    assert.equal(recomputed.dualFrameInfo.state, 'manual');
    assert.ok(Math.abs(recomputed.markAz - manual.markAz) < 1e-7);
    assert.ok(Math.abs(recomputed.markEl - manual.markEl) < 1e-7);
    await client.call('mark.save');
    await client.call('load', { dataDir: isolated, zipPath: path.join(sourceData, 'Camera4.zip') });
    const reloadedManual = await client.call('tree.select', { index: 1 });
    assert.equal(reloadedManual.frame, beforeManual.frame);
    // CSV 按 5 位小数保存偏移，允许相应的舍入误差。
    assert.ok(Math.abs(reloadedManual.markAz - manual.markAz) < 0.00001);
    assert.ok(Math.abs(reloadedManual.markEl - manual.markEl) < 0.00001);

    fs.writeFileSync(path.join(isolated, 'tree_centers2.txt'), 'invalid tree data\n', 'utf8');
    await assert.rejects(
      client.call(
        'load',
        { dataDir: isolated, zipPath: path.join(sourceData, 'Camera4.zip') },
        15000,
      ),
      /树心文件加载失败/,
    );
    const afterBadInput = await client.call('state');
    assert.equal(afterBadInput.loaded, true);
    assert.equal(afterBadInput.treeId, reloadedManual.treeId);

    // 用目录占用标注文件路径，模拟保存失败；桥接进程必须返回错误而不是弹出隐藏窗口。
    const unsavable = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-unsavable-'));
    for (const name of files.filter((name) => name !== 'manual_marks.csv')) {
      fs.copyFileSync(path.join(sourceData, name), path.join(unsavable, name));
    }
    await client.call('load', {
      dataDir: unsavable,
      zipPath: path.join(sourceData, 'Camera4.zip'),
    });
    fs.mkdirSync(path.join(unsavable, 'manual_marks.csv'));
    await client.call('mark.set', { x: 0.5, y: 0.6 });
    await assert.rejects(client.call('mark.save', {}, 15000), (error) => {
      assert.doesNotMatch(error.message, /超时/);
      return true;
    });
    assert.equal((await client.call('state')).markDirty, true);
  },
);

test(
  'switches between real datasets without mixing their state',
  { timeout: 180000 },
  async (t) => {
    const datasets = [
      { source: path.resolve(project, '..', 'dataset_runtime', 'data'), trees: 275, frames: 869 },
      {
        source: path.resolve(project, '..', 'dataset_runtime_full', 'data'),
        trees: 439,
        frames: 1522,
      },
    ];
    if (
      !fs.existsSync(executable) ||
      datasets.some((dataset) => !fs.existsSync(path.join(dataset.source, 'Camera4.zip')))
    ) {
      t.skip('Build the bridge and provide both sample datasets to run this test.');
      return;
    }

    const inputFiles = [
      'tree_centers2.txt',
      'Metashape.txt',
      'imgPosList.txt',
      'crown.csv',
      'trunk.csv',
      'manual_marks.csv',
    ];
    const client = createIsolatedClient(t);

    for (const dataset of datasets) {
      const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-switch-'));
      for (const name of inputFiles) {
        fs.copyFileSync(path.join(dataset.source, name), path.join(isolated, name));
      }
      const originalMarks = sha256(path.join(dataset.source, 'manual_marks.csv'));
      const loaded = await client.call('load', {
        dataDir: isolated,
        zipPath: path.join(dataset.source, 'Camera4.zip'),
      });
      assert.equal(loaded.treeCount, dataset.trees);
      assert.equal(loaded.frameCount, dataset.frames);
      const trees = await client.call('trees');
      assert.equal(trees.length, dataset.trees);
      assert.equal(trees[loaded.treeIndex - 1].id, loaded.treeId);
      const nearest = await client.call('tree.nearest');
      assert.equal(nearest.frame, loaded.frame);
      assert.equal(trees[nearest.treeIndex - 1].id, nearest.treeId);
      assert.match((await client.call('images')).photo, /^data:image\/jpeg;base64,/);
      assert.equal(sha256(path.join(dataset.source, 'manual_marks.csv')), originalMarks);
    }
  },
);
