'use strict';

// End-to-end bridge checks against a disposable data copy, with and without
// the local detector model. It never writes to the source data or source ZIP.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { BridgeClient } = require('../desktop-js/src/backend');
const { copyRuntime } = require('../desktop-js/tests/test-runtime');

const names = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseArgs(args) {
  const values = {};
  const allowed = new Set(['data', 'zip', 'bridge']);
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !allowed.has(args[i].slice(2)) || !args[i + 1])
      throw new Error('Invalid argument');
    const key = args[i].slice(2);
    if (Object.hasOwn(values, key)) throw new Error(`Repeated --${key}`);
    values[key] = path.resolve(args[i + 1]);
  }
  for (const key of allowed) if (!values[key]) throw new Error(`Missing --${key}`);
  return values;
}

function assertRiskStatus(state) {
  if (state.photoRisk.state === 'prior-overlap') assert.match(state.status, /画面可能包含拍摄者/);
  else if (state.photoRisk.state === 'detected') assert.match(state.status, /本地模型检出/);
  else if (state.photoRisk.state === 'detector-unavailable')
    assert.match(state.status, /人像检测不可用/);
  else assert.equal(state.photoRisk.state, 'unverified');
  if (/人像模型缺失|人像检测不可用/.test(state.photoRisk.reason)) {
    assert.match(state.status, /人像检测不可用/);
  }
}

async function checkCase(options, includeModel, directory) {
  const data = path.join(directory, 'data');
  fs.mkdirSync(data, { recursive: true });
  for (const name of names) fs.copyFileSync(path.join(options.data, name), path.join(data, name));
  const exe = copyRuntime(options.bridge, path.join(directory, 'runtime'), { includeModel });
  const client = new BridgeClient(exe);
  try {
    await assert.rejects(client.call('crop.inspect'), /还没有可保存的切图/);
    const loaded = await client.call('load', { dataDir: data, zipPath: options.zip });
    assert.equal(loaded.loaded, true);
    const state = await client.call('tree.select', { index: 120 });
    let nearest = await client.call('tree.nearest');
    assert.equal(nearest.frame, state.frame);
    assert.equal(nearest.autoFrame, false);
    assert.equal(nearest.targetValid, true);
    assertRiskStatus(nearest);
    if (!includeModel && nearest.photoRisk.state !== 'detector-unavailable') {
      // Exercise the unavailable-model warning independently of the geometric
      // operator-overlap warning; both must survive the nearest-tree action.
      for (const index of [1, 2, 3, 130, 140, 150, 160, 170]) {
        const selected = await client.call('tree.select', { index });
        nearest = await client.call('tree.nearest');
        assert.equal(nearest.frame, selected.frame);
        assertRiskStatus(nearest);
        if (nearest.photoRisk.state === 'detector-unavailable') break;
      }
      assert.equal(
        nearest.photoRisk.state,
        'detector-unavailable',
        'no sample exercised the unavailable warning',
      );
    }
    const snapshot = await client.call('photo.snapshot');
    if (includeModel) {
      assert.equal(snapshot.peopleDetection.status, 'complete');
      assert.equal(
        snapshot.peopleDetection.modelSha256,
        sha256(path.join(directory, 'runtime', 'models', 'person_head.onnx')),
      );
    } else {
      assert.equal(snapshot.peopleDetection.status, 'unavailable');
      assert.equal(snapshot.peopleDetection.personDetected, null);
      assert.equal(snapshot.peopleDetection.headDetected, null);
      assert.match(nearest.photoRisk.reason, /人像模型缺失|人像检测不可用/);
    }
    assert.equal(snapshot.peopleDetection.scalpDetected, null);
    const first = await client.call('crop.inspect');
    assert.match(first.imageSha256, /^[0-9a-f]{64}$/);
    // Even a model-negative crop requires human review: scalp is not detected.
    assert.equal(first.requiresReview, true);
    const output = path.join(directory, 'crop.png');
    await assert.rejects(
      client.call('crop.save', {
        path: output,
        imageSha256: '0'.repeat(64),
        reviewConfirmed: true,
      }),
      /切图内容已变化/,
    );
    assert.equal(fs.existsSync(output), false);
    await assert.rejects(
      client.call('crop.save', {
        path: output,
        imageSha256: first.imageSha256,
        reviewConfirmed: false,
      }),
      /人工检查|人工核查/,
    );
    assert.equal(fs.existsSync(output), false);
    const saved = await client.call('crop.save', {
      path: output,
      imageSha256: first.imageSha256,
      reviewConfirmed: true,
    });
    assert.equal(saved.imageSha256, first.imageSha256);
    assert.equal(sha256(output), first.imageSha256);
    assert.equal(saved.backupPath, null);

    // A user confirmation is tied to exact PNG bytes, not just a tree or frame.
    await client.call('mark.set', { x: 0.1, y: 0.1 });
    const changed = await client.call('crop.inspect');
    assert.notEqual(changed.imageSha256, first.imageSha256);
    await assert.rejects(
      client.call('crop.save', {
        path: output,
        imageSha256: first.imageSha256,
        reviewConfirmed: true,
      }),
      /切图内容已变化/,
    );
    assert.equal(sha256(output), first.imageSha256);
    const replaced = await client.call('crop.save', {
      path: output,
      imageSha256: changed.imageSha256,
      reviewConfirmed: true,
    });
    assert.equal(sha256(output), changed.imageSha256);
    assert.ok(replaced.backupPath);
    assert.equal(sha256(replaced.backupPath), first.imageSha256);
    let modelNegativeChecked = false;
    if (includeModel) {
      for (const index of [1, 2, 3, 130, 140, 150, 160, 170]) {
        await client.call('tree.select', { index });
        const negative = await client.call('crop.inspect');
        if (negative.status !== 'complete' || negative.personDetected || negative.headDetected)
          continue;
        assert.equal(negative.requiresReview, true);
        const unconfirmed = path.join(directory, 'unconfirmed.png');
        await assert.rejects(
          client.call('crop.save', {
            path: unconfirmed,
            imageSha256: negative.imageSha256,
            reviewConfirmed: false,
          }),
          /人工检查|人工核查/,
        );
        assert.equal(fs.existsSync(unconfirmed), false);
        modelNegativeChecked = true;
        break;
      }
      assert.equal(modelNegativeChecked, true, 'no model-negative crop was exercised');
    }
    await assert.rejects(
      client.call('crop.save', {
        path: path.join(data, 'manual_marks.csv'),
        imageSha256: changed.imageSha256,
        reviewConfirmed: true,
      }),
      /png/i,
    );
    return {
      includeModel,
      risk: nearest.photoRisk.state,
      inspection: first.status,
      cropPerson: first.personDetected,
      cropHead: first.headDetected,
      modelNegativeChecked,
    };
  } finally {
    const closed =
      client.child.exitCode === null && client.child.signalCode === null
        ? once(client.child, 'close')
        : Promise.resolve();
    client.close();
    await closed;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceHashes = Object.fromEntries(
    names.map((name) => [name, sha256(path.join(options.data, name))]),
  );
  const zip = fs.statSync(options.zip);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-crop-safety-'));
  const results = [];
  results.push(await checkCase(options, true, path.join(work, 'model-present')));
  results.push(await checkCase(options, false, path.join(work, 'model-missing')));
  for (const name of names) assert.equal(sha256(path.join(options.data, name)), sourceHashes[name]);
  const zipAfter = fs.statSync(options.zip);
  assert.equal(zipAfter.size, zip.size);
  assert.equal(zipAfter.mtimeMs, zip.mtimeMs);
  console.log('CROP SAFETY PASS: ' + JSON.stringify(results));
  console.log('Isolated evidence: ' + work);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
