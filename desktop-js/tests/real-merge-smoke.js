'use strict';

// 手动运行：必须显式给 TREEEXTRACT_REAL_MERGE_OUTPUT 指定输出目录，将写入约 5.2 GB。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeFolders, createMergedDataset } = require('../src/dataset-merge');
const { BridgeClient } = require('../src/backend');

async function main() {
  const destination = process.env.TREEEXTRACT_REAL_MERGE_OUTPUT;
  if (!destination)
    throw new Error('请设置 TREEEXTRACT_REAL_MERGE_OUTPUT；该测试会写入约 5.2 GB。');
  const desktop = path.resolve(__dirname, '..');
  const project = path.resolve(desktop, '..');
  const datasets = path.resolve(project, '..', 'dataset');
  const parents = fs
    .readdirSync(datasets, { withFileTypes: true })
    .filter((item) => item.isDirectory() && item.name.startsWith('9#-13#'));
  assert.equal(parents.length, 1);
  const parent = path.join(datasets, parents[0].name);
  const folders = fs
    .readdirSync(parent)
    .filter((name) => /^2026-09-18-06(3859|5910)/.test(name))
    .sort()
    .map((name) => path.join(parent, name));
  assert.equal(folders.length, 2);
  const trees = path.resolve(project, '..', 'dataset_runtime_full', 'data');
  const analysis = await analyzeFolders(folders, trees);
  assert.equal(analysis.ok, true, analysis.errors.join('\n'));
  assert.equal(analysis.imageCount, 1522);
  assert.equal(analysis.metaCount, 1397);
  assert.equal(analysis.treeCount, 439);
  console.log('分析通过，开始写入真实全景包。');
  const executable = path.join(desktop, 'runtime', 'TreeExtractorBridge.exe');
  const bridge = new BridgeClient(executable);
  try {
    const merged = await createMergedDataset(analysis, destination, (output, images) =>
      bridge.call('merge.archive', { output, images }, 4 * 60 * 60 * 1000),
    );
    console.log(`合并完成：${merged.directory}`);
    const loaded = await bridge.call('load', { dataDir: merged.directory, zipPath: '' }, 120000);
    assert.equal(loaded.loaded, true);
    assert.equal(loaded.frameCount, 1522);
    assert.equal(loaded.treeCount, 439);
    const first = await bridge.call('tree.select', { index: 1 }, 120000);
    const last = await bridge.call('tree.select', { index: 439 }, 120000);
    assert.ok(first.framePoseAvailable && last.framePoseAvailable);
    assert.ok(Number(first.frame.slice(0, -4)) >= 1789714760, '第一棵树应选到第二批次');
    assert.ok(Number(last.frame.slice(0, -4)) < 1789714760, '最后一棵树应选到第一批次');
    console.log(
      JSON.stringify(
        {
          passed: true,
          directory: merged.directory,
          frames: loaded.frameCount,
          trees: loaded.treeCount,
          samples: [first.frame, last.frame],
          warnings: merged.warnings,
        },
        null,
        2,
      ),
    );
  } finally {
    bridge.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
