'use strict';

// D2 real-bridge smoke: inspect the actual accepted A/B observations without
// rerunning detection. Source metadata is copied; the original ZIP is read-only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { BridgeClient } = require('../desktop-js/src/backend');
const { copyRuntime } = require('../desktop-js/tests/test-runtime');
const { validateDualEvidence } = require('./qa-dual-evidence-validation');

const DATA_FILES = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function argumentsOf(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !['--data', '--zip', '--bridge'].includes(key) ||
      !args[i + 1] ||
      Object.hasOwn(options, key)
    ) {
      throw new Error(`Invalid argument: ${key}`);
    }
    options[key] = path.resolve(args[i + 1]);
  }
  for (const key of ['--data', '--zip', '--bridge'])
    if (!options[key]) throw new Error(`Missing ${key}`);
  return options;
}

function processOk(executable, args, options = {}) {
  const result = spawnSync(executable, args, { ...options, maxBuffer: 40 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed: ${String(result.stderr)}`);
  return result.stdout;
}

function createSingleFrameZip(sourceZip, frame, directory) {
  if (!/^[0-9.]+\.jpg$/i.test(frame)) throw new Error('Unexpected frame name');
  const listing = processOk('tar.exe', ['-tf', sourceZip], { encoding: 'utf8' }).split(/\r?\n/);
  const matches = listing.filter((name) => name.endsWith('/JpgFiles/' + frame));
  if (matches.length !== 1) throw new Error(`Expected exactly one source entry for ${frame}`);
  const bytes = processOk('tar.exe', ['-xOf', sourceZip, matches[0]]);
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Extracted frame is not a JPEG');
  }
  const sourceDirectory = path.join(directory, 'single-frame-input');
  const images = path.join(sourceDirectory, 'Camera4', 'JpgFiles');
  fs.mkdirSync(images, { recursive: true });
  fs.writeFileSync(path.join(images, frame), bytes, { flag: 'wx' });
  const zip = path.join(directory, 'single-frame.zip');
  processOk('tar.exe', ['-a', '-cf', zip, `Camera4/JpgFiles/${frame}`], { cwd: sourceDirectory });
  const names = processOk('tar.exe', ['-tf', zip], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  assert.deepEqual(names, [`Camera4/JpgFiles/${frame}`]);
  return zip;
}

function createModifiedPairZip(sourceZip, frameA, frameB, directory) {
  for (const frame of [frameA, frameB])
    if (!/^[0-9.]+\.jpg$/i.test(frame)) throw new Error('Unexpected frame name');
  if (frameA === frameB) throw new Error('Pair frames must differ');
  const listing = processOk('tar.exe', ['-tf', sourceZip], { encoding: 'utf8' }).split(/\r?\n/);
  const sourceDirectory = path.join(directory, 'modified-pair-input');
  const images = path.join(sourceDirectory, 'Camera4', 'JpgFiles');
  fs.mkdirSync(images, { recursive: true });
  for (const frame of [frameA, frameB]) {
    const matches = listing.filter((name) => name.endsWith('/JpgFiles/' + frame));
    if (matches.length !== 1) throw new Error(`Expected exactly one source entry for ${frame}`);
    const bytes = processOk('tar.exe', ['-xOf', sourceZip, matches[0]]);
    const target = path.join(images, frame);
    if (frame === frameA) fs.writeFileSync(target, bytes, { flag: 'wx' });
    else {
      const original = path.join(directory, 'source-b-copy.jpg');
      fs.writeFileSync(original, bytes, { flag: 'wx' });
      processOk('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'qa-mutate-jpeg.ps1'),
        '-InputPath',
        original,
        '-OutputPath',
        target,
      ]);
      assert.notEqual(hashFile(original), hashFile(target));
    }
  }
  const zip = path.join(directory, 'modified-pair.zip');
  processOk(
    'tar.exe',
    ['-a', '-cf', zip, `Camera4/JpgFiles/${frameA}`, `Camera4/JpgFiles/${frameB}`],
    { cwd: sourceDirectory },
  );
  const names = processOk('tar.exe', ['-tf', zip], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  assert.deepEqual(
    new Set(names),
    new Set([`Camera4/JpgFiles/${frameA}`, `Camera4/JpgFiles/${frameB}`]),
  );
  return zip;
}

function summary(verified) {
  return {
    treeId: verified.treeId,
    treeIndex: verified.treeIndex,
    frameA: verified.frameA,
    frameB: verified.frameB,
    attempt: verified.attempt,
    observationA: verified.observationA,
    observationB: verified.observationB,
    images: Object.fromEntries(
      Object.entries(verified.images).map(([key, image]) => [
        key,
        {
          fileSha256: image.fileSha256,
          pixelSha256: image.pixelSha256,
          width: image.width,
          height: image.height,
        },
      ]),
    ),
  };
}

async function currentEvidence(client) {
  const snapshot = await client.call('photo.snapshot');
  const verified = validateDualEvidence(await client.call('dual.evidence'), snapshot);
  return { snapshot, verified };
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  delete process.env.TREEEXTRACT_EXPERIMENT_EDGE_CANDIDATE;
  const sourceHashes = Object.fromEntries(
    DATA_FILES.map((name) => [name, hashFile(path.join(options['--data'], name))]),
  );
  const zipBefore = fs.statSync(options['--zip']);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-dual-evidence-'));
  console.log(`Isolated working copy: ${work}`);
  const data = path.join(work, 'data');
  fs.mkdirSync(data);
  for (const name of DATA_FILES)
    fs.copyFileSync(path.join(options['--data'], name), path.join(data, name));
  // A user may later add a manual mark for tree 210. Remove only that row from
  // the disposable copy so the automatic-success regression remains stable.
  const marks = path.join(data, 'manual_marks.csv');
  const originalMarks = fs.readFileSync(marks, 'utf8');
  const newline = originalMarks.includes('\r\n') ? '\r\n' : '\n';
  const rows = originalMarks.split(/\r?\n/);
  const retained = rows.filter(
    (row) =>
      row
        .split(',')[0]
        .replace(/^\uFEFF/, '')
        .trim() !== '210',
  );
  if (retained.length !== rows.length) fs.writeFileSync(marks, retained.join(newline), 'utf8');
  const exe = copyRuntime(options['--bridge'], path.join(work, 'runtime'), { includeModel: true });
  const client = new BridgeClient(exe);
  const report = {
    evidenceSource: 'actual winning observations; not human ground truth',
    sourceHashes,
    isolatedManual210RowsRemoved: rows.length - retained.length,
    isolatedManualSha256: hashFile(marks),
    checks: [],
  };
  try {
    await client.call('load', { dataDir: data, zipPath: options['--zip'] });
    const trees = await client.call('trees');
    const target = trees.find((tree) => tree.id === 210);
    assert.ok(target, 'D2 tree ID 210 is missing');
    await client.call('view.options', {
      autoFrame: true,
      dualFrame: true,
      frameStrategy: 'quality',
    });
    const selected = await client.call('tree.select', { index: target.index });
    assert.equal(selected.treeId, 210);
    assert.equal(
      selected.dualFrameInfo.state,
      'success',
      'D2 tree 210 did not yield a success pair',
    );
    const first = await currentEvidence(client);
    assert.equal(first.verified.state, 'available');
    const before = await client.call('state');
    assert.equal(before.frame, selected.frame);
    assert.equal(before.markAz, selected.markAz);
    assert.equal(before.markEl, selected.markEl);
    const output = path.join(work, 'evidence');
    fs.mkdirSync(output);
    for (const [name, image] of Object.entries(first.verified.images)) {
      fs.writeFileSync(path.join(output, name + '.png'), image.bytes, { flag: 'wx' });
    }
    report.initial = summary(first.verified);
    report.checks.push('success_identity_and_independent_pixel_hashes');

    // Repeating the same settings requests the same cached pair. The .NET
    // algorithm regression separately verifies the cache-hit branch itself.
    await client.call('view.options', {
      autoFrame: true,
      dualFrame: true,
      frameStrategy: 'quality',
    });
    const repeated = await currentEvidence(client);
    assert.equal(repeated.verified.state, 'available');
    assert.deepEqual(summary(repeated.verified), report.initial);
    report.checks.push('repeat_same_pair');

    const other = trees.find((tree) => tree.id !== 210);
    assert.ok(other);
    const newTree = await client.call('tree.select', { index: other.index });
    const changedTree = await currentEvidence(client);
    assert.equal(changedTree.snapshot.treeId, newTree.treeId);
    if (changedTree.verified.state === 'available')
      assert.notEqual(changedTree.verified.treeId, 210);
    else assert.equal(changedTree.verified.state, 'unavailable');
    report.checks.push('tree_change_no_stale_evidence');

    await client.call('tree.select', { index: target.index });
    const priorFrame = await client.call('state');
    await client.call('frame.step', { direction: 1 });
    const changedFrame = await currentEvidence(client);
    assert.notEqual(changedFrame.snapshot.frame, priorFrame.frame);
    if (changedFrame.verified.state === 'available')
      assert.notEqual(changedFrame.verified.frameA, priorFrame.frame);
    else assert.equal(changedFrame.verified.state, 'unavailable');
    report.checks.push('frame_change_no_stale_evidence');

    const changedZip = createModifiedPairZip(
      options['--zip'],
      first.verified.frameA,
      first.verified.frameB,
      work,
    );
    await client.call('load', { dataDir: data, zipPath: changedZip });
    await client.call('view.options', {
      autoFrame: true,
      dualFrame: true,
      frameStrategy: 'quality',
    });
    await client.call('tree.select', { index: target.index });
    const changedSource = await currentEvidence(client);
    if (changedSource.verified.state === 'available') {
      const newPair = changedSource.verified;
      const changedObservation =
        newPair.frameA === first.verified.frameB ? newPair.observationA : newPair.observationB;
      assert.ok(
        newPair.frameA === first.verified.frameB || newPair.frameB === first.verified.frameB,
      );
      assert.notEqual(
        changedObservation.analysisPixelSha256,
        first.verified.observationB.analysisPixelSha256,
      );
    } else assert.equal(changedSource.verified.state, 'unavailable');
    report.checks.push('reloaded_same_B_name_different_pixels_no_stale_evidence');

    const miniZip = createSingleFrameZip(options['--zip'], first.verified.frameA, work);
    await client.call('load', { dataDir: data, zipPath: miniZip });
    await client.call('view.options', {
      autoFrame: true,
      dualFrame: true,
      frameStrategy: 'quality',
    });
    await client.call('tree.select', { index: target.index });
    const noSecondary = await currentEvidence(client);
    assert.equal(noSecondary.verified.state, 'unavailable');
    assert.notEqual(noSecondary.snapshot.dualFrameInfo.state, 'success');
    report.checks.push('reloaded_dataset_without_B_no_stale_evidence');
  } finally {
    const closed =
      client.child.exitCode === null && client.child.signalCode === null
        ? once(client.child, 'close')
        : Promise.resolve();
    client.close();
    await closed;
  }
  for (const name of DATA_FILES)
    assert.equal(hashFile(path.join(options['--data'], name)), sourceHashes[name]);
  const zipAfter = fs.statSync(options['--zip']);
  assert.equal(zipAfter.size, zipBefore.size);
  assert.equal(zipAfter.mtimeMs, zipBefore.mtimeMs);
  fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log('DUAL EVIDENCE PASS: ' + JSON.stringify(report.checks));
  console.log('Evidence: ' + work);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
