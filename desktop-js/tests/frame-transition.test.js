'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { BridgeClient } = require('../src/backend');
const { copyRuntime, removeTemporary } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const source = path.resolve(desktop, '..', '..', 'tree');
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

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 不调用产品选帧函数：只对 ZIP 内有完整位姿的照片做水平距离暴力比较。
function buildOracle(directory, zip) {
  const listing = spawnSync('tar.exe', ['-tf', zip], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(listing.status, 0, listing.stderr);
  const names = new Set(
    listing.stdout.split(/\r?\n/).map((line) => {
      const match = line.match(/JpgFiles\/([0-9.]+\.jpg)$/i);
      return match ? match[1].toLowerCase() : '';
    }),
  );
  const frames = fs
    .readFileSync(path.join(directory, 'Metashape.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row.length >= 7 && names.has(row[0].toLowerCase()))
    .map((row) => ({ name: row[0], pose: row.slice(1, 7).map(Number) }))
    .filter((frame) => frame.pose.every(Number.isFinite))
    .sort((a, b) => Number.parseFloat(a.name) - Number.parseFloat(b.name));
  const trees = new Map();
  for (const line of fs
    .readFileSync(path.join(directory, 'tree_centers2.txt'), 'utf8')
    .split(/\r?\n/)) {
    const row = line.trim().split(/\s+/);
    const id = Number(row[0]),
      x = Number(row[1]),
      y = Number(row[2]);
    if (row.length >= 5 && Number.isInteger(id) && Number.isFinite(x) && Number.isFinite(y))
      trees.set(id, { x, y });
  }
  const axes = new Map();
  for (const line of fs.readFileSync(path.join(directory, 'trunk.csv'), 'utf8').split(/\r?\n/)) {
    const row = line.split(',');
    if (row.length < 6 || !row[0].trim() || !row[4].trim() || !row[5].trim()) continue;
    const id = Number(row[0]),
      x = Number(row[4]),
      y = Number(row[5]);
    if ([id, x, y].every(Number.isFinite)) axes.set(id, { x, y });
  }
  return (id) => {
    const center = trees.get(id);
    const axis = axes.get(id) || center;
    assert.ok(center && axis && frames.length);
    let best;
    for (const frame of frames) {
      const distance = Math.hypot(axis.x - frame.pose[0], axis.y - frame.pose[1]);
      if (!best || distance < best.distance) best = { ...frame, distance };
    }
    const bearing =
      ((Math.atan2(center.x - best.pose[0], center.y - best.pose[1]) * 180) / Math.PI + 360) % 360;
    return { ...best, bearing };
  };
}

function assertNearestTarget(state, index, oracle, idMatchesIndex = true) {
  assert.equal(state.treeIndex, index);
  if (idMatchesIndex) assert.equal(state.treeId, index, '默认数据集树 ID 应与本测试序号一致');
  assert.equal(state.autoFrame, true, '选择不同树后应恢复自动选帧');
  const expected = oracle(state.treeId);
  assert.equal(state.frame, expected.name, '水平最近帧应与独立基准一致');
  assert.ok(Math.abs(state.cameraHorizontalDistance - expected.distance) < 1e-6, '相机水平距离');
  const difference = ((state.bearing - expected.bearing + 540) % 360) - 180;
  assert.ok(Math.abs(difference) < 1e-7, '目标方位应由新相机和当前树心计算');
}

async function stepToFrameWithPose(client) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = await client.call('frame.step', { direction: 1 });
    if (state.cameraHorizontalDistance !== null) return state;
  }
  throw new Error('附近 20 帧都没有有效相机位姿');
}

async function stepToFrameWithoutPose(client) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await client.call('frame.step', { direction: -1 });
    if (state.cameraHorizontalDistance === null) return state;
  }
  throw new Error('附近 40 帧均有位姿，无法覆盖缺位姿分支');
}

test('切树与固定帧状态转换', { timeout: 240000 }, async (t) => {
  if (!fs.existsSync(executable) || !fs.existsSync(path.join(source, 'Camera4.zip'))) {
    if (process.env.TREEEXTRACT_TEST_BRIDGE) assert.fail('指定的测试后端不存在');
    t.skip('需要构建后端并提供默认全景数据');
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract frame transition '));
  const data = path.join(temporary, 'data');
  fs.mkdirSync(data);
  const original = new Map();
  function copyDataset(input, destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of files) {
      const file = path.join(input, name);
      original.set(file, hash(file));
      fs.copyFileSync(file, path.join(destination, name));
    }
  }
  copyDataset(source, data);
  const zip = path.join(source, 'Camera4.zip');
  const oracle = buildOracle(data, zip);
  const client = new BridgeClient(
    copyRuntime(executable, path.join(temporary, 'runtime'), { includeModel: false }),
  );
  t.after(async () => {
    const closed =
      client.child.exitCode === null && client.child.signalCode === null
        ? once(client.child, 'close')
        : Promise.resolve();
    client.close();
    await closed;
    for (const [file, value] of original) assert.equal(hash(file), value, file);
    removeTemporary(temporary, 'treeextract frame transition ');
  });
  await client.call('load', { dataDir: data, zipPath: zip });

  await t.test('固定后重选同一棵保留当前帧；切到其他树恢复自动', async () => {
    await client.call('view.options', { frameStrategy: 'nearest', dualFrame: false });
    assertNearestTarget(await client.call('tree.select', { index: 120 }), 120, oracle);
    const fixed = await stepToFrameWithPose(client);
    assert.equal(fixed.autoFrame, false);
    const same = await client.call('tree.select', { index: 120 });
    assert.equal(same.frame, fixed.frame, '重选同树应保留手动帧');
    assert.equal(same.autoFrame, false);
    assertNearestTarget(await client.call('tree.select', { index: 170 }), 170, oracle);
  });

  await t.test('当前帧最近树保持该帧；改选其他树恢复自动', async () => {
    await client.call('view.options', { frameStrategy: 'nearest', dualFrame: false });
    const initial = await client.call('tree.select', { index: 120 });
    const nearest = await client.call('tree.nearest');
    assert.equal(nearest.frame, initial.frame, '当前帧最近树不得切换帧');
    assert.equal(nearest.autoFrame, false);
    const same = await client.call('tree.select', { index: nearest.treeIndex });
    assert.equal(same.frame, nearest.frame);
    assert.equal(same.autoFrame, false);
    const different = nearest.treeIndex === 170 ? 120 : 170;
    assertNearestTarget(await client.call('tree.select', { index: different }), different, oracle);
  });

  await t.test('缺位姿固定帧只显示全景并明确告警', async () => {
    await client.call('view.options', { frameStrategy: 'nearest', dualFrame: false });
    assertNearestTarget(await client.call('tree.select', { index: 120 }), 120, oracle);
    const missing = await stepToFrameWithoutPose(client);
    assert.equal(missing.autoFrame, false);
    assert.equal(missing.cameraHorizontalDistance, null);
    assert.equal(missing.markMode, '无定位结果');
    assert.match(missing.status, /缺少完整相机位姿/);
    assert.equal(missing.photoRisk.state, 'unavailable');
    assert.match(missing.photoRisk.reason, /缺少完整相机位姿/);
    assert.equal(missing.markAz, null);
    assert.equal(missing.markEl, null);
    assert.equal(missing.photoMarkNormalized, null);
    const missingImages = await client.call('images');
    assert.match(missingImages.panorama, /^data:image\/jpeg;base64,/);
    assert.ok(missingImages.photo === null, '缺位姿时不得显示旧目标方向的 4:3 照片');
    const missingSnapshot = await client.call('photo.snapshot');
    assert.equal(missingSnapshot.frame, missing.frame);
    assert.equal(missingSnapshot.photoClean, null);
    assert.equal(missingSnapshot.photoMarked, null);
    assert.equal(missingSnapshot.photoMarkNormalized, null);
    assert.ok(missingImages.crop === null, '缺位姿时不得显示旧目标方向的切图');
  });

  await t.test('缺位姿固定帧重选同树不静默跳帧，改选其他树恢复自动', async () => {
    await client.call('view.options', { frameStrategy: 'nearest', dualFrame: false });
    await client.call('tree.select', { index: 120 });
    const missing = await stepToFrameWithoutPose(client);
    const same = await client.call('tree.select', { index: 120 });
    assert.equal(same.frame, missing.frame, '缺位姿时重选同树不得静默换帧');
    assert.equal(same.autoFrame, false);
    assert.equal(same.cameraHorizontalDistance, null);
    assert.equal(same.markMode, '无定位结果');
    assert.match(same.status, /缺少完整相机位姿/);
    assert.equal(same.photoRisk.state, 'unavailable');
    assert.match(same.photoRisk.reason, /缺少完整相机位姿/);
    const sameImages = await client.call('images');
    assert.ok(sameImages.photo === null);
    assert.ok(sameImages.crop === null);
    assertNearestTarget(await client.call('tree.select', { index: 170 }), 170, oracle);
  });

  await t.test('固定帧后切换数据集，首棵选中树恢复自动并重新定位', async (subtest) => {
    const otherSets = [
      path.resolve(desktop, '..', '..', 'dataset_runtime', 'data'),
      path.resolve(desktop, '..', '..', 'dataset_runtime_full', 'data'),
    ];
    if (otherSets.some((directory) => !fs.existsSync(path.join(directory, 'Camera4.zip')))) {
      subtest.skip('需要提供第二、第三套数据');
      return;
    }
    await client.call('view.options', { frameStrategy: 'nearest', dualFrame: false });
    await client.call('tree.select', { index: 120 });
    assert.equal((await stepToFrameWithPose(client)).autoFrame, false);
    for (const [index, input] of otherSets.entries()) {
      const destination = path.join(temporary, `data-${index + 2}`);
      copyDataset(input, destination);
      const dataZip = path.join(input, 'Camera4.zip');
      const dataOracle = buildOracle(destination, dataZip);
      const loaded = await client.call('load', { dataDir: destination, zipPath: dataZip });
      assert.equal(loaded.loaded, true);
      assertNearestTarget(loaded, loaded.treeIndex, dataOracle, false);
      const treeList = await client.call('trees');
      assert.equal(treeList[loaded.treeIndex - 1].id, loaded.treeId);
      if (index + 1 < otherSets.length)
        assert.equal((await stepToFrameWithPose(client)).autoFrame, false);
    }
  });

  await t.test('树干轴心和相机水平重合时保留零距离，不伪造目标方向', async () => {
    const destination = path.join(temporary, 'data-zero-distance');
    copyDataset(source, destination);
    const centerLine = fs
      .readFileSync(path.join(destination, 'tree_centers2.txt'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find((row) => Number(row[0]) === 120);
    assert.ok(centerLine);
    const frameName = oracle(120).name;
    let poseChanged = false;
    const posePath = path.join(destination, 'Metashape.txt');
    const poses = fs
      .readFileSync(posePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => {
        const row = line.trim().split(/\s+/);
        if (row[0] !== frameName) return line;
        row[1] = centerLine[1];
        row[2] = centerLine[2];
        poseChanged = true;
        return row.join(' ');
      });
    assert.ok(poseChanged);
    fs.writeFileSync(posePath, poses.join('\n'));
    let axisChanged = false;
    const axisPath = path.join(destination, 'trunk.csv');
    const axes = fs
      .readFileSync(axisPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => {
        const row = line.split(',');
        if (Number(row[0]) !== 120) return line;
        row[4] = centerLine[1];
        row[5] = centerLine[2];
        axisChanged = true;
        return row.join(',');
      });
    assert.ok(axisChanged);
    fs.writeFileSync(axisPath, axes.join('\n'));
    await client.call('load', { dataDir: destination, zipPath: zip });
    await client.call('view.options', { frameStrategy: 'nearest', dualFrame: false });
    const state = await client.call('tree.select', { index: 120 });
    assert.equal(state.frame, frameName);
    assert.equal(state.cameraHorizontalDistance, 0, '有效的零水平距离不能被当成缺失');
    assert.equal(state.distanceUsesTrunkAxis, true);
    assert.equal(state.markAz, null);
    assert.equal(state.markEl, null);
    assert.match(
      `${state.status} ${state.markMode}`,
      /重合|零距|方位.*(?:未定义|无法|不可)|距离.*(?:过近|无效|为零)/,
    );
    const result = await client.call('images');
    assert.ok(result.photo === null, '零距离时不应生成假定方位的照片');
    assert.ok(result.crop === null, '零距离时不应生成假定方位的切图');
    const nearest = await client.call('tree.nearest');
    assert.equal(nearest.treeId, 120);
    assert.equal(nearest.frame, frameName);
    assert.equal(nearest.cameraHorizontalDistance, 0);
    assert.equal(nearest.markAz, null);
    assert.equal(nearest.markEl, null);
    assert.match(nearest.status, /无法确定树干方向/);
  });

  await t.test('缺少有效树高时水平最近仍可选相机，但不得伪造标注', async () => {
    const destination = path.join(temporary, 'data-invalid-height');
    copyDataset(source, destination);
    const treePath = path.join(destination, 'tree_centers2.txt');
    let changed = false;
    const lines = fs
      .readFileSync(treePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => {
        const row = line.trim().split(/\s+/);
        if (Number(row[0]) !== 120 || row.length < 5) return line;
        row[4] = '0';
        changed = true;
        return row.join(' ');
      });
    assert.equal(changed, true);
    fs.writeFileSync(treePath, lines.join('\n'));
    await client.call('load', { dataDir: destination, zipPath: zip });
    await client.call('view.options', { frameStrategy: 'nearest', dualFrame: false });
    const nearest = await client.call('tree.select', { index: 120 });
    assert.equal(nearest.frame, oracle(120).name);
    assert.ok(Number.isFinite(nearest.cameraHorizontalDistance));
    assert.equal(nearest.markAz, null);
    assert.equal(nearest.markEl, null);
    assert.match(nearest.status, /树高|高程/);
    const images = await client.call('images');
    assert.ok(images.photo === null && images.crop === null);
    const quality = await client.call('view.options', { frameStrategy: 'quality' });
    assert.match(quality.status, /树高|高程/);
    assert.equal(quality.markAz, null);
    assert.equal(quality.markEl, null);
    const qualityImages = await client.call('images');
    assert.ok(qualityImages.photo === null && qualityImages.crop === null);
  });

  await t.test('数据集没有任何有效相机位姿时拒绝或明确禁用派生图', async () => {
    const destination = path.join(temporary, 'data-no-poses');
    copyDataset(source, destination);
    fs.writeFileSync(path.join(destination, 'Metashape.txt'), '# no valid camera poses\n');
    let loaded;
    try {
      loaded = await client.call('load', { dataDir: destination, zipPath: zip });
    } catch (error) {
      assert.match(error.message, /位姿|姿态|相机坐标|pose|camera/i);
      const after = await client.call('state');
      if (after.dataDir === destination) {
        const result = await client.call('images');
        assert.ok(result.photo === null && result.crop === null);
      }
      return;
    }
    assert.equal(loaded.cameraHorizontalDistance, null);
    assert.equal(loaded.markAz, null);
    assert.equal(loaded.markEl, null);
    assert.match(`${loaded.status} ${loaded.markMode}`, /位姿|姿态|相机坐标/);
    const result = await client.call('images');
    assert.ok(result.photo === null, '无相机位姿不能生成带目标的照片');
    assert.ok(result.crop === null, '无相机位姿不能生成目标切图');
  });
});
