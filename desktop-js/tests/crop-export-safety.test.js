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
const source = path.resolve(desktop, '..', '..', 'tree');
const executable =
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe');
const zip = path.join(source, 'Camera4.zip');
const dataNames = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function prepare(t, withoutModel) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-crop-safety-'));
  const data = path.join(temporary, 'data');
  const runtime = path.join(temporary, 'runtime');
  fs.mkdirSync(data);
  for (const name of dataNames) fs.copyFileSync(path.join(source, name), path.join(data, name));
  const copied = copyRuntime(executable, runtime);
  const model = path.join(runtime, 'models', 'person_head.onnx');
  if (withoutModel && fs.existsSync(model)) fs.unlinkSync(model);
  const client = new BridgeClient(copied);
  t.after(async () => {
    const closed =
      client.child.exitCode === null && client.child.signalCode === null
        ? once(client.child, 'close')
        : Promise.resolve();
    client.close();
    await closed;
    removeTemporary(temporary, 'treeextract-crop-safety-');
  });
  return { client, temporary, data };
}

test('切图检测不可用时必须确认，拒绝陈旧内容及覆盖原始输入', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(executable) || !fs.existsSync(zip)) {
    if (process.env.TREEEXTRACT_TEST_BRIDGE) assert.fail('指定的测试后端或默认数据不存在');
    t.skip('需要后端和默认数据');
    return;
  }
  const { client, temporary, data } = prepare(t, true);
  const originalMarks = fs.readFileSync(path.join(source, 'manual_marks.csv'));
  const before = await client.call('photo.snapshot');
  assert.equal(before.peopleDetection.status, 'unavailable');
  assert.equal(before.peopleDetection.headDetected, null);
  await client.call('load', { dataDir: data, zipPath: zip });
  const missing = await client.call('photo.snapshot');
  assert.equal(missing.peopleDetection.status, 'unavailable');
  assert.equal(missing.peopleDetection.personDetected, null);
  assert.equal(missing.peopleDetection.headDetected, null);
  assert.equal(missing.peopleDetection.scalpDetected, null);

  const inspection = await client.call('crop.inspect');
  assert.equal(inspection.status, 'unavailable');
  assert.equal(inspection.requiresReview, true);
  assert.match(inspection.imageSha256, /^[a-f0-9]{64}$/);

  const destination = path.join(temporary, 'output.png');
  const old = Buffer.from('previous user content');
  fs.writeFileSync(destination, old);
  await assert.rejects(
    client.call('crop.save', { path: destination, imageSha256: inspection.imageSha256 }),
    /人工检查|确认/,
  );
  assert.deepEqual(fs.readFileSync(destination), old);

  const marks = path.join(data, 'manual_marks.csv');
  const savedMarks = fs.readFileSync(marks);
  await assert.rejects(
    client.call('crop.save', {
      path: marks,
      imageSha256: inspection.imageSha256,
      reviewConfirmed: true,
    }),
    /\.png|输入|标注/,
  );
  assert.deepEqual(fs.readFileSync(marks), savedMarks);

  const saved = await client.call('crop.save', {
    path: destination,
    imageSha256: inspection.imageSha256,
    reviewConfirmed: true,
  });
  assert.equal(hash(fs.readFileSync(destination)), inspection.imageSha256);
  assert.deepEqual(fs.readFileSync(saved.backupPath), old);

  await client.call('tree.select', { index: 1 });
  const changed = await client.call('crop.inspect');
  assert.notEqual(changed.imageSha256, inspection.imageSha256);
  const beforeStaleWrite = hash(fs.readFileSync(destination));
  await assert.rejects(
    client.call('crop.save', {
      path: destination,
      imageSha256: inspection.imageSha256,
      reviewConfirmed: true,
    }),
    /切图内容已变化/,
  );
  assert.equal(hash(fs.readFileSync(destination)), beforeStaleWrite);

  // 在真实默认数据中找到固定帧最近树与拍摄者经验区域重叠的场景。
  // 模型缺失时两种警告必须同时存在，不能只显示几何先验而掩盖检测故障。
  let overlapObserved = false;
  let noOverlapObserved = false;
  for (const index of [157, 163, 164, 120, 130, 140, 150, 160, 170]) {
    await client.call('tree.select', { index });
    const nearest = await client.call('tree.nearest');
    if (nearest.photoRisk.state === 'prior-overlap') {
      assert.match(nearest.status, /可能包含拍摄者/);
      assert.match(nearest.status, /人像检测不可用/);
      assert.match(nearest.photoRisk.reason, /人像模型缺失/);
      overlapObserved = true;
    } else if (nearest.photoRisk.state === 'detector-unavailable') {
      assert.match(nearest.status, /人像检测不可用/);
      noOverlapObserved = true;
    }
    if (overlapObserved && noOverlapObserved) break;
  }
  assert.equal(overlapObserved, true, '测试数据未覆盖几何重叠及模型缺失的组合');
  assert.equal(noOverlapObserved, true, '测试数据未覆盖几何不重叠及模型缺失的组合');
  assert.deepEqual(fs.readFileSync(path.join(source, 'manual_marks.csv')), originalMarks);
});

test('实际切图检测结果与独立切图快照一致', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(executable) || !fs.existsSync(zip)) {
    if (process.env.TREEEXTRACT_TEST_BRIDGE) assert.fail('指定的测试后端或默认数据不存在');
    t.skip('需要后端和默认数据');
    return;
  }
  const { client, data, temporary } = prepare(t, false);
  await client.call('load', { dataDir: data, zipPath: zip });
  const images = await client.call('images');
  const inspection = await client.call('crop.inspect');
  assert.equal(inspection.status, 'complete');
  assert.deepEqual(images.cropPeopleDetection, {
    status: inspection.status,
    personDetected: inspection.personDetected,
    headDetected: inspection.headDetected,
    scalpDetected: null,
    model: inspection.model,
    modelSha256: inspection.modelSha256,
    scoreThreshold: inspection.scoreThreshold,
    error: null,
  });
  assert.equal(inspection.requiresReview, true);
  assert.equal(inspection.scalpDetected, null);
  const output = path.join(temporary, 'requires-review.png');
  await assert.rejects(
    client.call('crop.save', { path: output, imageSha256: inspection.imageSha256 }),
    /人工检查|确认/,
  );
  assert.equal(fs.existsSync(output), false);
});
