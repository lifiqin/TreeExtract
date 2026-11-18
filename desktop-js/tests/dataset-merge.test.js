'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeFolders, createMergedDataset, crdSignature } = require('../src/dataset-merge');
const { mapLimited, MAX_IMAGE_BYTES, validateImageLength } = require('../src/capture-reader');

const jpeg = Buffer.from('ffd8ffc00011080b40168003011100021100031100ffd9', 'hex');
const header = 'ImageName GPSTime Longitude Latitude H_Ell Roll Pitch Heading\n';
const metaHeader = 'imageName X Y Z Omega Phi Kappa\n';

function crd(state = 1, projection = 9) {
  return Buffer.concat([
    Buffer.from([projection]),
    ...['stateBD', 'stateLD', 'stateHD'].map((key) =>
      Buffer.concat([Buffer.from(key), Buffer.alloc(8, state)]),
    ),
  ]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-merge-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('treeextract-merge-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  function capture(name, base, settings = {}) {
    const dir = path.join(root, name);
    const pic = path.join(dir, 'Camera4', 'Picture');
    fs.mkdirSync(path.join(pic, 'PictureData'), { recursive: true });
    const names = settings.names || [`${base}.1.jpg`, `${base}.2.jpg`];
    for (const n of names) fs.writeFileSync(path.join(pic, 'PictureData', n), jpeg);
    fs.writeFileSync(path.join(pic, 'Camera4Param.txt'), settings.camera || 'same camera');
    fs.writeFileSync(
      path.join(pic, 'Metashape.txt'),
      metaHeader +
        names
          .slice(0, settings.metaCount ?? 1)
          .map((n) => `${n} 10 20 3 0 0 0`)
          .join('\n') +
        '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'imgPosList.txt'),
      header +
        `${base}.1 ${base}.1 120 30 10 0 0 1\n${base}.2 ${base}.2 120 30 10 0 0 1\n${base}.1 ${base}.1 120 30 10 1 1 2\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'Block_1.xml'),
      `<x><Definition>${settings.projection || 'same projection'}</Definition></x>`,
    );
    fs.writeFileSync(
      path.join(dir, 'PointCloud.crd'),
      crd(settings.state || 1, settings.crdProjection || 9),
    );
    return dir;
  }
  const treeDir = path.join(root, 'tree-data');
  fs.mkdirSync(treeDir);
  fs.writeFileSync(
    path.join(treeDir, 'tree_centers2.txt'),
    'ID X Y Z Height Species\n1 10 20 3 5 tree\n',
  );
  fs.writeFileSync(path.join(treeDir, 'manual_marks.csv'), 'do not copy');
  fs.writeFileSync(path.join(treeDir, 'trunk.csv'), 'Id,N,Zmin,Zmax,Tux,Tuy\n1,2,3,4,10,20\n');
  return { root, capture, treeDir };
}

test('坐标状态字段可变化，但投影字节变化不能忽略', () => {
  assert.equal(crdSignature(crd(1, 9)), crdSignature(crd(2, 9)));
  assert.notEqual(crdSignature(crd(1, 9)), crdSignature(crd(2, 8)));
  assert.notEqual(crdSignature(Buffer.from('unknown-a')), crdSignature(Buffer.from('unknown-b')));
});

test('合并分析与后端共享 128 MiB 的单帧大小边界', () => {
  assert.equal(MAX_IMAGE_BYTES, 128 * 1024 * 1024);
  assert.match(
    fs.readFileSync(path.join(__dirname, '../../src/FrameStore.cs'), 'utf8'),
    /MaxImageBytes\s*=\s*128L\s*\*\s*1024\s*\*\s*1024/,
  );
  assert.doesNotThrow(() => validateImageLength(MAX_IMAGE_BYTES, 'frame.jpg'));
  assert.throws(() => validateImageLength(MAX_IMAGE_BYTES + 1, 'frame.jpg'), /128 MiB/);
  assert.throws(() => validateImageLength(0, 'frame.jpg'), /为空/);
});

test('分析两批原始数据并按第一镜头通道排序，不补造缺失姿态', async (t) => {
  const f = fixture(t);
  const a = f.capture('a', 100),
    b = f.capture('b', 200, { state: 2 });
  const result = await analyzeFolders([b, a], f.treeDir);
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.equal(result.imageCount, 4);
  assert.equal(result.metaCount, 2);
  assert.equal(result.poseCount, 4);
  assert.equal(result.treeCount, 1);
  assert.deepEqual(
    result.plan.poses.map((row) => row.time),
    [100.1, 100.2, 200.1, 200.2],
  );
  assert.ok(result.warnings.some((x) => x.includes('2 张照片缺少')));
});

test('缺树心时可以合并但明确提示不能加载树列表', async (t) => {
  const f = fixture(t);
  const a = f.capture('a', 100),
    b = f.capture('b', 200);
  const result = await analyzeFolders([a, b]);
  assert.equal(result.ok, true);
  assert.equal(result.treeCount, 0);
  assert.ok(result.warnings.some((x) => x.includes('不能直接加载树列表')));
});

test('无表头的树心和配套表不会丢失首条记录', async (t) => {
  const f = fixture(t);
  const a = f.capture('a', 100),
    b = f.capture('b', 200);
  fs.writeFileSync(path.join(f.treeDir, 'tree_centers2.txt'), '1 10 20 3 5 tree\n');
  fs.writeFileSync(path.join(f.treeDir, 'trunk.csv'), '1,2,3,4,10,20\n');
  const result = await analyzeFolders([a, b], f.treeDir);
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.equal(result.treeCount, 1);
  assert.equal(result.plan.trees.optional.length, 1);
  assert.ok(result.warnings.some((x) => x.includes('JPEG 文件头')));
});

test('并发检查失败时等待已开始的任务结束，不继续调度后续文件', async () => {
  const events = [];
  await assert.rejects(
    mapLimited([0, 1, 2], 2, async (item) => {
      events.push(`start-${item}`);
      if (item === 0) {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('bad');
      }
      await new Promise((r) => setTimeout(r, 35));
      events.push(`done-${item}`);
    }),
    /bad/,
  );
  assert.deepEqual(events, ['start-0', 'start-1', 'done-1']);
});

test('不兼容、重名、无效图片和远离的树心均拒绝合并', async (t) => {
  const f = fixture(t);
  const a = f.capture('a', 100);
  const different = f.capture('different', 200, {
    projection: 'other',
    camera: 'other',
    crdProjection: 8,
  });
  let result = await analyzeFolders([a, different]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes('投影')));
  assert.ok(result.errors.some((x) => x.includes('相机')));
  const duplicate = f.capture('duplicate', 300, { names: ['100.1.jpg'] });
  result = await analyzeFolders([a, duplicate]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes('照片名冲突')));
  const invalid = f.capture('invalid', 400);
  fs.writeFileSync(path.join(invalid, 'Camera4', 'Picture', 'PictureData', '400.1.jpg'), 'broken');
  assert.equal((await analyzeFolders([a, invalid])).ok, false);
  const valid = f.capture('valid', 500);
  fs.writeFileSync(
    path.join(f.treeDir, 'tree_centers2.txt'),
    'ID X Y Z Height Species\n1 10000 10000 3 5 tree\n',
  );
  result = await analyzeFolders([a, valid], f.treeDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes('100 米')));
});

test('不支持大写照片扩展名，IMU 覆盖不足时提示而不是伪造位姿', async (t) => {
  const f = fixture(t);
  const a = f.capture('a', 100);
  const uppercase = f.capture('uppercase', 200, { names: ['200.1.JPG'] });
  const blocked = await analyzeFolders([a, uppercase]);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some((x) => x.includes('小写 .jpg')));
  const sparse = f.capture('sparse', 300, { names: ['300.1.jpg', '310.1.jpg'] });
  const result = await analyzeFolders([a, sparse]);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((x) => x.includes('2 秒内没有')));
});

test('IMU 覆盖保留两侧最近记录、重复时间和恰好两秒的边界', async (t) => {
  const f = fixture(t);
  const a = f.capture('boundaries', 100, {
    names: ['97.999', '98', '100', '102', '102.001', '108', '110', '112', '112.001'].map(
      (time) => `${time}.jpg`,
    ),
  });
  const b = f.capture('b', 200);
  fs.writeFileSync(
    path.join(a, 'imgPosList.txt'),
    header + [100, 100, 110, 100].map((time) => `${time} ${time} 120 30 10 0 0 1`).join('\n'),
  );
  const result = await analyzeFolders([a, b]);
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.deepEqual(
    result.warnings.filter((warning) => warning.includes('第一路 IMU')),
    ['boundaries：3 张照片附近 2 秒内没有第一路 IMU 记录，方向回退可能不可靠。'],
  );
  assert.deepEqual(
    result.plan.poses.map((row) => row.time),
    [100, 110, 200.1, 200.2],
  );
});

test('输出独立目录，保留原图和树心，不携带旧人工校正', async (t) => {
  const f = fixture(t);
  const a = f.capture('a', 100),
    b = f.capture('b', 200);
  const analysis = await analyzeFolders([a, b], f.treeDir);
  const result = await createMergedDataset(analysis, f.root, async (target, images) => {
    assert.equal(images.length, 4);
    fs.writeFileSync(target, 'test archive', { flag: 'wx' });
  });
  assert.equal(result.loadable, true);
  assert.ok(fs.existsSync(path.join(result.directory, 'Camera4.zip')));
  assert.equal(fs.existsSync(path.join(result.directory, 'manual_marks.csv')), false);
  assert.ok(fs.existsSync(path.join(result.directory, 'trunk.csv')));
  assert.equal(
    fs.readFileSync(path.join(a, 'Camera4', 'Picture', 'PictureData', '100.1.jpg')).equals(jpeg),
    true,
  );
  assert.equal(
    fs.readFileSync(path.join(result.directory, 'Metashape.txt'), 'utf8'),
    metaHeader + '100.1.jpg 10 20 3 0 0 0\n200.1.jpg 10 20 3 0 0 0\n',
  );
  assert.equal(
    fs.readFileSync(path.join(result.directory, 'imgPosList.txt'), 'utf8'),
    header +
      ['100.1', '100.2', '200.1', '200.2']
        .map((time) => `${time} ${time} 120 30 10 0 0 1\n`)
        .join(''),
  );
  for (const name of ['tree_centers2.txt', 'trunk.csv'])
    assert.deepEqual(
      fs.readFileSync(path.join(result.directory, name)),
      fs.readFileSync(path.join(f.treeDir, name)),
    );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(result.directory, 'merge-report.json'), 'utf8')).metaCount,
    2,
  );
});

test('合并配套文件始终独占创建，遇到已有文件时保留暂存内容且不发布', async (t) => {
  for (const name of [
    'Metashape.txt',
    'imgPosList.txt',
    'tree_centers2.txt',
    'crown.csv',
    'trunk.csv',
    'merge-report.json',
  ]) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      const a = f.capture('a', 100),
        b = f.capture('b', 200);
      fs.writeFileSync(path.join(f.treeDir, 'crown.csv'), 'Id,Width\n1,5\n');
      const analysis = await analyzeFolders([a, b], f.treeDir);
      let stage;
      await assert.rejects(
        createMergedDataset(analysis, f.root, async (target) => {
          stage = path.dirname(target);
          fs.writeFileSync(target, 'test archive', { flag: 'wx' });
          fs.writeFileSync(path.join(stage, name), 'existing bytes', { flag: 'wx' });
        }),
        /合并未完成.*未完成目录保留.*EEXIST/,
      );
      assert.equal(fs.readFileSync(path.join(stage, name), 'utf8'), 'existing bytes');
      assert.deepEqual(
        fs.readdirSync(f.root).filter((entry) => entry.startsWith('TreeExtract_merge_')),
        [path.basename(stage)],
      );
      assert.ok(stage.endsWith('_incomplete'));
    });
  }
});

test('无树心的影像合并仍输出完整配套文件，但明确不可加载树列表', async (t) => {
  const f = fixture(t);
  const a = f.capture('a', 100),
    b = f.capture('b', 200);
  const analysis = await analyzeFolders([a, b]);
  const result = await createMergedDataset(analysis, f.root, async (target) => {
    fs.writeFileSync(target, 'test archive', { flag: 'wx' });
  });
  assert.equal(result.loadable, false);
  assert.equal(result.treeCount, 0);
  assert.deepEqual(fs.readdirSync(result.directory).sort(), [
    'Camera4.zip',
    'Metashape.txt',
    'imgPosList.txt',
    'merge-report.json',
  ]);
  const report = JSON.parse(fs.readFileSync(path.join(result.directory, 'merge-report.json')));
  assert.equal(report.version, 1);
  assert.equal(report.treeDirectory, null);
  assert.deepEqual(report.warnings, analysis.warnings);
});

test('源数据变化、输出落在输入内部、归档失败都不会覆盖原始数据', async (t) => {
  const f = fixture(t);
  const a = f.capture('a', 100),
    b = f.capture('b', 200);
  let analysis = await analyzeFolders([a, b]);
  await assert.rejects(
    createMergedDataset(analysis, a, async () => {}),
    /输出位置不能/,
  );
  fs.appendFileSync(path.join(a, 'Camera4', 'Picture', 'PictureData', '100.1.jpg'), 'changed');
  await assert.rejects(
    createMergedDataset(analysis, f.root, async () => {}),
    /源文件.*发生变化/,
  );
  analysis = await analyzeFolders([a, b]);
  await assert.rejects(
    createMergedDataset(analysis, f.root, async () => {
      throw new Error('disk full');
    }),
    /未完成目录保留/,
  );
  assert.ok(fs.readdirSync(f.root).some((name) => name.endsWith('_incomplete')));
  assert.ok(fs.existsSync(path.join(a, 'imgPosList.txt')));
});
