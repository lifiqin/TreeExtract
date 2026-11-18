'use strict';

// 对三套真实数据比较两版后端的模型输入、原始结果及热力图；不输出图片。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { BridgeClient } = require('../src/backend');
const { copyRuntime } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const parent = path.resolve(desktop, '..', '..');
const baseline = process.env.TREEEXTRACT_BASELINE_BRIDGE;
const candidate = process.env.TREEEXTRACT_TEST_BRIDGE;
if (!baseline || !candidate)
  throw new Error('Set TREEEXTRACT_BASELINE_BRIDGE and TREEEXTRACT_TEST_BRIDGE.');
const datasets = [
  { name: 'D1', source: path.join(parent, 'tree'), indices: [1, 150] },
  { name: 'D2', source: path.join(parent, 'dataset_runtime', 'data'), indices: [1, 120] },
  { name: 'D3', source: path.join(parent, 'dataset_runtime_full', 'data'), indices: [1, 120] },
];
const names = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-recognition-regression-'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => hash(fs.readFileSync(file));
const jpegHash = (url) => hash(Buffer.from(url.split(',')[1], 'base64'));

async function evaluate(executable, data, zip, indices) {
  const client = new BridgeClient(executable);
  const rows = [];
  try {
    await client.call('load', { dataDir: data, zipPath: zip });
    for (const index of indices) {
      const state = await client.call('tree.select', { index });
      const snapshot = await client.call('recognition.snapshot');
      const start = performance.now();
      const recognized = await client.call('recognize');
      const elapsed = performance.now() - start;
      const images = await client.call('images');
      assert.ok(images.heat, '缺少本地热力图');
      rows.push({
        treeId: state.treeId,
        frame: state.frame,
        input: snapshot.imageSha256,
        name: recognized.name,
        probability: recognized.probability,
        topNames: recognized.topNames,
        topProbs: recognized.topProbs,
        heat: jpegHash(images.heat),
        elapsedMs: elapsed,
      });
    }
    return rows;
  } finally {
    client.close();
  }
}

async function run() {
  const originalExe = copyRuntime(baseline, path.join(temporary, 'baseline'));
  const candidateExe = copyRuntime(candidate, path.join(temporary, 'candidate'));
  let count = 0;
  const beforeTimes = [];
  const afterTimes = [];
  for (const dataset of datasets) {
    const data = path.join(temporary, dataset.name);
    const zip = path.join(dataset.source, 'Camera4.zip');
    fs.mkdirSync(data);
    const before = Object.fromEntries(
      names.map((name) => [name, fileHash(path.join(dataset.source, name))]),
    );
    const zipBefore = fs.statSync(zip);
    for (const name of names)
      fs.copyFileSync(path.join(dataset.source, name), path.join(data, name));
    const original = await evaluate(originalExe, data, zip, dataset.indices);
    const updated = await evaluate(candidateExe, data, zip, dataset.indices);
    for (let i = 0; i < original.length; i += 1) {
      const a = original[i];
      const b = updated[i];
      assert.equal(b.treeId, a.treeId);
      assert.equal(b.frame, a.frame);
      assert.equal(b.input, a.input, '识别输入发生变化');
      assert.equal(b.name, a.name);
      assert.deepEqual(b.topNames, a.topNames);
      assert.ok(Math.abs(b.probability - a.probability) < 1e-7);
      for (let k = 0; k < a.topProbs.length; k += 1)
        assert.ok(Math.abs(b.topProbs[k] - a.topProbs[k]) < 1e-7);
      assert.equal(b.heat, a.heat, '热力图内容发生变化');
      beforeTimes.push(a.elapsedMs);
      afterTimes.push(b.elapsedMs);
      count += 1;
    }
    for (const name of names) assert.equal(fileHash(path.join(dataset.source, name)), before[name]);
    const afterZip = fs.statSync(zip);
    assert.equal(afterZip.size, zipBefore.size);
    assert.equal(afterZip.mtimeMs, zipBefore.mtimeMs);
    console.log(`${dataset.name}: ${original.length} recognition and heatmap comparisons passed`);
  }
  beforeTimes.sort((a, b) => a - b);
  afterTimes.sort((a, b) => a - b);
  console.log(
    `RECOGNITION REGRESSION PASS: ${count}; median old/new ${beforeTimes[Math.floor(count / 2)].toFixed(1)}/${afterTimes[Math.floor(count / 2)].toFixed(1)} ms`,
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
