'use strict';

// 与真实默认照片配合的可复现反例：保留两个位置相同的相机位姿，
// 故意制造零基线，使双帧无法交会；所有写入只发生在临时数据副本中。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { BridgeClient } = require('../src/backend');
const { copyRuntime, removeTemporary } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const source = path.resolve(desktop, '..', '..', 'tree');
const zip = path.join(source, 'Camera4.zip');
const executable =
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe');
const inputFiles = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const mainFrame = '1788406062.246988.jpg';

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function imageHash(value) {
  assert.match(value, /^data:image\/jpeg;base64,/);
  return hashBytes(Buffer.from(value.slice(value.indexOf(',') + 1), 'base64'));
}

function selectedFrameNames() {
  const list = spawnSync('tar.exe', ['-tf', zip], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(list.status, 0, list.stderr);
  const names = list.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/JpgFiles\/([0-9.]+\.jpg)$/i))
    .filter(Boolean)
    .map((match) => match[1])
    .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));
  const index = names.indexOf(mainFrame);
  assert.ok(index >= 0 && index + 1 < names.length, '缺少隔离回归所需相邻照片');
  return [mainFrame, names[index + 1]];
}

function prepareData(destination, frameNames, hasAxis, manual) {
  fs.mkdirSync(destination);
  for (const name of inputFiles)
    fs.copyFileSync(path.join(source, name), path.join(destination, name));
  const posePath = path.join(destination, 'Metashape.txt');
  const lines = fs.readFileSync(posePath, 'utf8').split(/\r?\n/);
  const row = lines.find((line) => line.trim().split(/\s+/)[0] === mainFrame);
  assert.ok(row, '主帧缺少原始位姿');
  const pose = row.trim().split(/\s+/).slice(1, 7);
  assert.equal(pose.length, 6);
  assert.ok(pose.every((value) => Number.isFinite(Number(value))));
  fs.writeFileSync(
    posePath,
    [
      'imageName X Y Z Omega Phi Kappa',
      ...frameNames.map((name) => [name, ...pose].join(' ')),
    ].join('\n'),
    'utf8',
  );
  const axisPath = path.join(destination, 'trunk.csv');
  const axes = fs.readFileSync(axisPath, 'utf8').split(/\r?\n/);
  assert.ok(axes.some((line) => line.split(',')[0] === '120'));
  if (!hasAxis)
    fs.writeFileSync(axisPath, axes.filter((line) => line.split(',')[0] !== '120').join('\n'));
  const markPath = path.join(destination, 'manual_marks.csv');
  let marks = fs
    .readFileSync(markPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.split(',')[0] !== '120');
  if (manual) marks.push('120,0.50000,-0.30000');
  fs.writeFileSync(markPath, marks.join('\n'), 'utf8');

  // 独立算出当前发布版的回退高度及其世界角度；它只是估计基线，并非真实树干中点。
  const tree = fs
    .readFileSync(path.join(destination, 'tree_centers2.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns[0] === '120');
  assert.ok(tree && tree.length >= 5);
  const center = tree.slice(1, 5).map(Number);
  const axis = axes.find((line) => line.split(',')[0] === '120').split(',');
  const xy = hasAxis ? [Number(axis[4]), Number(axis[5])] : center.slice(0, 2);
  const camera = pose.map(Number);
  const height = center[3];
  const ceiling = Math.max(0.8, Math.min(0.35 * height, 2.0));
  const estimatedHeight = Math.min(Math.max(0.12 * height, 0.8), ceiling);
  const expectedAz =
    ((Math.atan2(xy[0] - camera[0], xy[1] - camera[1]) * 180) / Math.PI + 360) % 360;
  const expectedEl =
    (Math.atan2(
      center[2] + estimatedHeight - camera[2],
      Math.hypot(xy[0] - camera[0], xy[1] - camera[1]),
    ) *
      180) /
    Math.PI;
  return { expectedAz, expectedEl };
}

async function snapshot(client, enabled, expectedFrame, manual) {
  const state = await client.call('view.options', { dualFrame: enabled });
  assert.equal(state.frame, expectedFrame, '切换双帧开关不能改变固定帧');
  assert.equal(state.treeId, 120);
  assert.equal(state.targetValid, true);
  assert.equal(state.dualFrameInfo.state, manual ? 'manual' : enabled ? 'fallback' : 'disabled');
  assert.ok(Number.isFinite(state.markAz) && Number.isFinite(state.markEl));
  const images = await client.call('images');
  return {
    az: state.markAz,
    el: state.markEl,
    photo: imageHash(images.photo),
    crop: imageHash(images.crop),
    frame: state.frame,
    status: state.dualFrameInfo.state,
    reason: state.dualFrameInfo.reason,
  };
}

function assertManualUnchanged(single, dual) {
  assert.equal(dual.frame, single.frame);
  assert.ok(Math.abs(dual.az - single.az) < 1e-7, '双帧不能改动人工方位');
  assert.ok(Math.abs(dual.el - single.el) < 1e-7, '双帧不能改动人工仰角');
  assert.equal(dual.photo, single.photo, '人工优先时 4:3 不得改变');
  assert.equal(dual.crop, single.crop, '人工优先时切图不得改变');
}

function assertHonestFallback(dual, expected) {
  assert.equal(dual.status, 'fallback');
  assert.match(dual.reason, /估计|核验|核查/);
  const azDifference = ((dual.az - expected.expectedAz + 540) % 360) - 180;
  assert.ok(Math.abs(azDifference) < 1e-7, '回退方向不应偏离既有轴心/树心基线');
  assert.ok(Math.abs(dual.el - expected.expectedEl) < 1e-7, '回退高度需保留当前发布版估计基线');
}

test('双帧失败保持估计基线，人工校正优先（有无轴心、换帧）', { timeout: 240000 }, async (t) => {
  if (!fs.existsSync(executable) || !fs.existsSync(zip)) {
    if (process.env.TREEEXTRACT_TEST_BRIDGE) assert.fail('指定的后端或默认数据不存在');
    t.skip('需要构建后端并提供默认全景数据');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-dual-baseline-'));
  const hashes = new Map(
    inputFiles.map((name) => [name, hashBytes(fs.readFileSync(path.join(source, name)))]),
  );
  const zipBefore = fs.statSync(zip);
  const client = new BridgeClient(
    copyRuntime(executable, path.join(temp, 'runtime'), { includeModel: false }),
  );
  t.after(async () => {
    const closed =
      client.child.exitCode === null && client.child.signalCode === null
        ? once(client.child, 'close')
        : Promise.resolve();
    client.close();
    await closed;
    for (const [name, hash] of hashes)
      assert.equal(hashBytes(fs.readFileSync(path.join(source, name))), hash);
    const zipAfter = fs.statSync(zip);
    assert.equal(zipAfter.size, zipBefore.size);
    assert.equal(zipAfter.mtimeMs, zipBefore.mtimeMs);
    removeTemporary(temp, 'treeextract-dual-baseline-');
  });
  const frames = selectedFrameNames();
  for (const hasAxis of [true, false]) {
    for (const manual of [false, true]) {
      await t.test(`轴心=${hasAxis} 人工校正=${manual}`, async () => {
        const data = path.join(temp, `data-${hasAxis}-${manual}`);
        const expected = prepareData(data, frames, hasAxis, manual);
        await client.call('load', { dataDir: data, zipPath: zip });
        await client.call('view.options', { dualFrame: false, frameStrategy: 'nearest' });
        const selected = await client.call('tree.select', { index: 120 });
        assert.equal(selected.frame, frames[0]);
        const singleA = await snapshot(client, false, frames[0], manual);
        const dualA = await snapshot(client, true, frames[0], manual);
        if (manual) assertManualUnchanged(singleA, dualA);
        else assertHonestFallback(dualA, expected);
        const stepped = await client.call('frame.step', { direction: 1 });
        assert.equal(stepped.autoFrame, false);
        assert.equal(stepped.frame, frames[1]);
        const singleB = await snapshot(client, false, frames[1], manual);
        const dualB = await snapshot(client, true, frames[1], manual);
        if (manual) assertManualUnchanged(singleB, dualB);
        else assertHonestFallback(dualB, expected);
      });
    }
  }
});

test('改变视图投影后重新计算辅助帧，不沿用旧缓存', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(executable) || !fs.existsSync(zip)) {
    if (process.env.TREEEXTRACT_TEST_BRIDGE) assert.fail('指定的后端或默认数据不存在');
    t.skip('需要构建后端并提供默认全景数据');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-dual-cache-'));
  const data = path.join(temp, 'data');
  const runtime = path.join(temp, 'runtime');
  fs.mkdirSync(data);
  const hashes = new Map(
    inputFiles.map((name) => [name, hashBytes(fs.readFileSync(path.join(source, name)))]),
  );
  for (const name of inputFiles) fs.copyFileSync(path.join(source, name), path.join(data, name));
  const client = new BridgeClient(copyRuntime(executable, runtime, { includeModel: false }));
  t.after(async () => {
    const closed =
      client.child.exitCode === null && client.child.signalCode === null
        ? once(client.child, 'close')
        : Promise.resolve();
    client.close();
    await closed;
    for (const [name, hash] of hashes)
      assert.equal(hashBytes(fs.readFileSync(path.join(source, name))), hash);
    removeTemporary(temp, 'treeextract-dual-cache-');
  });

  function analysisCount() {
    const log = path.join(runtime, 'error.log');
    if (!fs.existsSync(log)) return 0;
    return fs
      .readFileSync(log, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('双帧 树120 ') && line.includes('缓存=未命中')).length;
  }
  function comparable(state) {
    return {
      frame: state.frame,
      dual: state.dualFrameInfo,
      risk: state.photoRisk,
      markAz: state.markAz,
      markEl: state.markEl,
    };
  }
  async function forcedRefresh(previous) {
    await client.call('view.options', { dualFrame: false });
    const fresh = await client.call('view.options', { dualFrame: true });
    assert.deepEqual(comparable(previous), comparable(fresh), '清除缓存后 B、风险和红圈应完全一致');
    return fresh;
  }

  await client.call('load', { dataDir: data, zipPath: zip });
  await client.call('view.options', { dualFrame: true, frameStrategy: 'quality' });
  const selected = await client.call('tree.select', { index: 120 });
  assert.ok(['success', 'fallback'].includes(selected.dualFrameInfo.state));
  // 先锁住同一有效主帧：后续检查只考察取景参数变化，不能误把换 A 当成缓存失效。
  const next = await client.call('frame.step', { direction: 1 });
  const fixed = await client.call('frame.step', { direction: -1 });
  assert.equal(fixed.frame, selected.frame);
  assert.equal(fixed.autoFrame, false);
  assert.notEqual(next.frame, fixed.frame);
  let previousCount = analysisCount();
  assert.ok(previousCount >= 1, '应能在隔离日志中找到该树的真实分析记录');
  await client.call('view.options', { viewFov: fixed.viewFov === 80 ? 85 : 80 });
  assert.equal(analysisCount(), previousCount, '仅改变预览视角不应重复分析同一双帧');

  const leveled = await client.call('view.options', { levelView: !fixed.levelView });
  assert.equal(leveled.frame, fixed.frame);
  assert.ok(analysisCount() > previousCount, '水平取景改变后必须清缓存并重新分析 B');
  const afterLevel = await forcedRefresh(leveled);
  previousCount = analysisCount();

  const projected = await client.call('view.options', { lowDistortion: !afterLevel.lowDistortion });
  assert.equal(projected.frame, fixed.frame);
  assert.ok(analysisCount() > previousCount, '投影模式改变后必须清缓存并重新分析 B');
  const afterProjection = await forcedRefresh(projected);

  previousCount = analysisCount();
  const bearing = (afterProjection.bearing + 25) % 360;
  const shifted = await client.call('view.options', { bearing });
  assert.equal(shifted.frame, fixed.frame);
  assert.equal(shifted.autoFrame, false);
  assert.ok(analysisCount() > previousCount, '人工改变 4:3 方位必须重新分析当前投影');
  const afterBearing = await forcedRefresh(shifted);

  previousCount = analysisCount();
  const elevation = Math.max(-89, Math.min(89, afterBearing.elevation + 10));
  const tilted = await client.call('view.options', { elevation });
  assert.equal(tilted.frame, fixed.frame);
  assert.equal(tilted.autoFrame, false);
  assert.ok(analysisCount() > previousCount, '人工改变 4:3 仰角必须重新分析当前投影');
  await forcedRefresh(tilted);
});
