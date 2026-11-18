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
const executable =
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe');

test('自动主帧不跨树复用；帧不足明确停止，手动复用时显示风险', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(executable)) return t.skip('需要已构建的后端。');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-frame-guard-'));
  const runtime = path.join(temporary, 'runtime');
  const sourceImage = path.join(project, 'tests', 'fixtures', 'qa-blank-100x50.jpg');
  const client = new BridgeClient(copyRuntime(executable, runtime, { includeModel: false }));
  const images = [];
  for (const name of ['1.000000.jpg', '2.000000.jpg']) {
    const source = path.join(temporary, name);
    fs.copyFileSync(sourceImage, source);
    const stat = fs.statSync(source);
    images.push({ source, name, length: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
  }

  async function fixture(name, count, firstId, secondId, distantSecond = false) {
    const directory = path.join(temporary, name);
    fs.mkdirSync(directory);
    await client.call('merge.archive', {
      output: path.join(directory, 'Camera4.zip'),
      images: images.slice(0, count),
    });
    fs.writeFileSync(
      path.join(directory, 'tree_centers2.txt'),
      `${firstId} 0 10 0 8 tree\n${secondId} 0.1 6.8 0 8 tree\n`,
    );
    fs.writeFileSync(path.join(directory, 'manual_marks.csv'), `${firstId},1,2\n`);
    fs.writeFileSync(
      path.join(directory, 'Metashape.txt'),
      'imageName X Y Z Omega Phi Kappa\n' +
        '1.000000.jpg 0 0 1.5 0 0 0\n' +
        (count > 1 ? `2.000000.jpg ${distantSecond ? '1000' : '10'} 5 1.5 0 0 0\n` : ''),
    );
    fs.writeFileSync(
      path.join(directory, 'imgPosList.txt'),
      'ImageName GPSTime Longitude Latitude H_Ell Roll Pitch Heading\n' +
        '1 1 0 0 0 0 0 0\n2 2 0 0 0 0 0 0\n',
    );
    return directory;
  }

  try {
    const multi = await fixture('multiple', 2, 101, 202);
    const single = await fixture('single', 1, 303, 404);
    const distant = await fixture('distant', 2, 505, 606, true);
    await client.call('load', { dataDir: multi, zipPath: '' });
    await client.call('view.options', { dualFrame: false });
    const first = await client.call('tree.select', { index: 1 });
    const second = await client.call('tree.select', { index: 2 });
    assert.equal(first.treeId, 101);
    assert.equal(first.dualFrameInfo.state, 'manual', '人工校正仍优先');
    assert.match(first.frameSelectionWarning, /已有人工校正.*核查红圈/);
    assert.equal(second.treeId, 202);
    assert.ok(first.frame && second.frame, '两个有效帧都应能使用');
    assert.notEqual(first.frame, second.frame, '不同树的自动主帧不得相同');
    assert.equal((await client.call('tree.select', { index: 1 })).frame, first.frame);
    assert.equal((await client.call('tree.select', { index: 2 })).frame, second.frame);

    const loaded = await client.call('load', { dataDir: single, zipPath: '' });
    assert.ok(loaded.frame, '切换数据集必须释放上一数据集的预留');
    const ownerIndex = loaded.treeIndex;
    const otherIndex = ownerIndex === 1 ? 2 : 1;
    const unavailable = await client.call('tree.select', { index: otherIndex });
    assert.equal(unavailable.frame, '', '仅有的帧已预留时不应冒充独立画面');
    assert.equal(unavailable.targetValid, false);
    assert.match(unavailable.status, /没有可用的独立自动主帧/);
    assert.match(unavailable.frameSelectionWarning, /没有可用的独立自动主帧/);
    assert.equal((await client.call('images')).photo, null, '不能沿用上一棵树的照片');

    const manual = await client.call('view.options', { autoFrame: false });
    assert.ok(manual.frame, '保留用户手动查看原帧的能力');
    assert.match(manual.frameSelectionWarning, /已用于树/);
    assert.match(manual.frameSelectionWarning, /可能遮挡或误认/);
    const nearest = await client.call('view.options', { frameStrategy: 'nearest' });
    assert.equal(nearest.frame, loaded.frame, '严格最近模式仍选择真实最近帧');
    assert.match(nearest.frameSelectionWarning, /已用于树/, '严格最近模式复用时必须警告');
    const restored = await client.call('tree.select', { index: ownerIndex });
    assert.equal(restored.frame, loaded.frame, '原树的预留保持稳定');

    await client.call('load', { dataDir: distant, zipPath: '' });
    const farLoaded = await client.call('view.options', { frameStrategy: 'quality' });
    const farOther = farLoaded.treeIndex === 1 ? 2 : 1;
    const noNearFrame = await client.call('tree.select', { index: farOther });
    assert.equal(noNearFrame.frame, '', '不能为了去重而选择 30 米外的远景冒充合适画面');
    assert.match(noNearFrame.frameSelectionWarning, /没有可用的独立自动主帧/);
  } finally {
    const closed = client.child.exitCode === null ? once(client.child, 'close') : Promise.resolve();
    client.close();
    await closed;
    removeTemporary(temporary, 'treeextract-frame-guard-');
  }
});
