'use strict';

// Collect photos for independent review. The backend, mutable metadata and all
// writes are isolated in temporary directories; the original ZIP is read-only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { BridgeClient } = require('../desktop-js/src/backend');
const { copyRuntime } = require('../desktop-js/tests/test-runtime');
const { validateDualEvidence } = require('./qa-dual-evidence-validation');
const {
  PREDICTION_SCHEMA,
  LABEL_SCHEMA,
  sha256,
  jpegDimensions,
  emptyLabel,
} = require('./qa-annotations');

const requiredFiles = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];

function parseArguments(args) {
  const options = {};
  const required = ['dataset', 'data', 'zip', 'bridge', 'from-index', 'to-index'];
  const allowed = new Set([...required, 'require-model', 'require-evidence']);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (
      !name.startsWith('--') ||
      !allowed.has(name.slice(2)) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    ) {
      throw new Error(`Invalid argument: ${name}`);
    }
    const key = name.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Repeated argument: ${name}`);
    options[key] = args[i + 1];
  }
  for (const key of required) if (!options[key]) throw new Error(`Missing --${key}`);
  for (const name of ['require-model', 'require-evidence']) {
    if (options[name] && !['true', 'false'].includes(options[name])) {
      throw new Error(`--${name} must be true or false`);
    }
  }
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(options.dataset)) throw new Error('Invalid dataset ID');
  for (const key of ['from-index', 'to-index']) {
    if (!/^[1-9]\d*$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) {
      throw new Error(`--${key} must be a positive 1-based index`);
    }
    options[key] = Number(options[key]);
  }
  if (
    options['to-index'] < options['from-index'] ||
    options['to-index'] - options['from-index'] >= 5000
  ) {
    throw new Error('Invalid index range; at most 5000 samples per collection');
  }
  for (const key of ['data', 'zip', 'bridge']) options[key] = path.resolve(options[key]);
  return options;
}

function readJpegDataUrl(value, description) {
  const match =
    typeof value === 'string' && value.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error(`${description}: missing JPEG data`);
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) throw new Error(`${description}: invalid base64`);
  return { bytes, ...jpegDimensions(bytes), sha256: sha256(bytes) };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function smallInputHashes(directory) {
  return Object.fromEntries(
    requiredFiles.map((name) => [name, sha256(fs.readFileSync(path.join(directory, name)))]),
  );
}

// Only explicit, fully validated model decisions can be assessed as predictions.
// Geometric risk, missing detections and head detections never imply scalp status.
function mapPeopleDetection(detection, hasPhoto, observedModelSha256 = null) {
  const unknown = { person: 'unknown', head: 'unknown', scalp: 'unknown' };
  if (detection === null || detection === undefined) {
    return { status: 'unavailable', reason: 'not_provided', predictions: unknown };
  }
  if (typeof detection !== 'object' || Array.isArray(detection)) {
    return { status: 'invalid', reason: 'invalid_detection', predictions: unknown };
  }
  if (
    detection.status === 'unavailable' &&
    detection.personDetected === null &&
    detection.headDetected === null &&
    detection.scalpDetected === null
  ) {
    return {
      status: 'unavailable',
      reason: 'model_unavailable',
      error: typeof detection.error === 'string' ? detection.error : null,
      predictions: unknown,
    };
  }
  const complete =
    hasPhoto &&
    detection.status === 'complete' &&
    typeof detection.personDetected === 'boolean' &&
    typeof detection.headDetected === 'boolean' &&
    !(detection.headDetected && !detection.personDetected) &&
    detection.scalpDetected === null &&
    typeof detection.model === 'string' &&
    detection.model.trim().length > 0 &&
    typeof detection.modelSha256 === 'string' &&
    /^[0-9a-f]{64}$/i.test(detection.modelSha256) &&
    Number.isFinite(detection.scoreThreshold) &&
    detection.scoreThreshold >= 0 &&
    detection.scoreThreshold <= 1 &&
    detection.error === null;
  if (!complete)
    return { status: 'invalid', reason: 'inconsistent_detection', predictions: unknown };
  if (!observedModelSha256 || detection.modelSha256.toLowerCase() !== observedModelSha256) {
    return { status: 'invalid', reason: 'model_hash_mismatch', predictions: unknown };
  }
  return {
    status: 'complete',
    reason: null,
    model: detection.model,
    modelSha256: observedModelSha256,
    scoreThreshold: detection.scoreThreshold,
    predictions: {
      person: detection.personDetected ? 'present' : 'absent',
      head: detection.headDetected ? 'present' : 'absent',
      scalp: 'unknown',
    },
  };
}

function snapshotSample(dataset, index, state, snapshot, cleanDir, markedDir, modelSha256 = null) {
  if (
    snapshot.treeIndex !== index ||
    snapshot.treeId !== state.treeId ||
    snapshot.frame !== state.frame
  ) {
    throw new Error(`Snapshot identity changed at tree index ${index}`);
  }
  const dual = snapshot.dualFrameInfo || {};
  const detection = mapPeopleDetection(
    snapshot.peopleDetection,
    Boolean(snapshot.photoClean && snapshot.photoMarked),
    modelSha256,
  );
  const sample = {
    sampleId: `${dataset}:${index}`,
    treeIndex: index,
    treeId: snapshot.treeId,
    frameA: snapshot.frame || '',
    image: null,
    markedImage: null,
    predictedPoint: null,
    markSource: dual.state === 'manual' ? 'manual' : 'automatic',
    dual: { state: dual.state || 'unavailable', frameB: dual.frameB || null },
    dualDiagnostics: dual,
    photoRisk: snapshot.photoRisk || null,
    peopleDetection: detection,
    peoplePrediction: detection.predictions,
  };
  if (snapshot.photoClean !== null || snapshot.photoMarked !== null) {
    const clean = readJpegDataUrl(snapshot.photoClean, `${sample.sampleId}.clean`);
    const marked = readJpegDataUrl(snapshot.photoMarked, `${sample.sampleId}.marked`);
    if (
      clean.width !== marked.width ||
      clean.height !== marked.height ||
      clean.width !== snapshot.width ||
      clean.height !== snapshot.height
    ) {
      throw new Error(`${sample.sampleId}: clean/marked photo dimensions differ`);
    }
    if (clean.width * 3 !== clean.height * 4)
      throw new Error(`${sample.sampleId}: expected a 4:3 photo`);
    if (snapshot.photoMarkNormalized !== null) {
      const point = snapshot.photoMarkNormalized;
      if (
        !point ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.inFrame !== (point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
      ) {
        throw new Error(`${sample.sampleId}: invalid normalized marker`);
      }
      sample.predictedPoint = { x: point.x, y: point.y };
    }
    const base = String(index).padStart(6, '0');
    const cleanName = `${base}-clean.jpg`;
    const markedName = `${base}-marked.jpg`;
    fs.writeFileSync(path.join(cleanDir, cleanName), clean.bytes, { flag: 'wx' });
    fs.writeFileSync(path.join(markedDir, markedName), marked.bytes, { flag: 'wx' });
    sample.image = {
      path: `../labels/clean/${cleanName}`,
      kind: 'clean',
      sha256: clean.sha256,
      width: clean.width,
      height: clean.height,
    };
    sample.markedImage = {
      path: `marked/${markedName}`,
      sha256: marked.sha256,
      width: marked.width,
      height: marked.height,
    };
  } else if (
    snapshot.width !== null ||
    snapshot.height !== null ||
    snapshot.photoMarkNormalized !== null
  ) {
    throw new Error(`${sample.sampleId}: missing photo has inconsistent metadata`);
  }
  return sample;
}

function storePairEvidence(verified, index, evidenceDir) {
  if (verified.state !== 'available') return verified;
  const pairDir = path.join(evidenceDir, 'pairs');
  fs.mkdirSync(pairDir, { recursive: true });
  const images = {};
  for (const [key, image] of Object.entries(verified.images)) {
    const name = `${String(index).padStart(6, '0')}-${key}.png`;
    fs.writeFileSync(path.join(pairDir, name), image.bytes, { flag: 'wx' });
    images[key] = {
      path: `pairs/${name}`,
      fileSha256: image.fileSha256,
      pixelSha256: image.pixelSha256,
      width: image.width,
      height: image.height,
    };
  }
  return {
    state: 'available',
    reason: verified.reason,
    treeId: verified.treeId,
    treeIndex: verified.treeIndex,
    frameA: verified.frameA,
    frameB: verified.frameB,
    attempt: verified.attempt,
    hashFormat: verified.hashFormat,
    observationA: verified.observationA,
    observationB: verified.observationB,
    images,
  };
}

async function collect(options) {
  const before = smallInputHashes(options.data);
  const zipBefore = fs.statSync(options.zip);
  if (!zipBefore.isFile()) throw new Error('ZIP is not a file');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-qa-work-'));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-qa-collection-'));
  console.log(`Isolated working copy: ${work}`);
  console.log(`Collection staging: ${output}`);
  const data = path.join(work, 'data');
  const cleanDir = path.join(output, 'labels', 'clean');
  const markedDir = path.join(output, 'evidence', 'marked');
  fs.mkdirSync(data);
  fs.mkdirSync(cleanDir, { recursive: true });
  fs.mkdirSync(markedDir, { recursive: true });
  for (const name of requiredFiles)
    fs.copyFileSync(path.join(options.data, name), path.join(data, name));
  const executable = copyRuntime(options.bridge, path.join(work, 'runtime'), {
    includeModel: true,
  });
  const backendDir = path.dirname(executable);
  const backendHashes = {};
  for (const name of [
    path.basename(options.bridge),
    'TreeExtractorBridge.dll',
    'TreeExtractorBridge.runtimeconfig.json',
  ]) {
    const file = path.join(backendDir, name);
    if (fs.existsSync(file)) backendHashes[name] = sha256(fs.readFileSync(file));
  }
  const modelPath = path.join(path.dirname(executable), 'models', 'person_head.onnx');
  const modelSha256 = fs.existsSync(modelPath) ? sha256(fs.readFileSync(modelPath)) : null;
  backendHashes['models/person_head.onnx'] = modelSha256;
  const predictions = {
    schema: PREDICTION_SCHEMA,
    dataset: options.dataset,
    generatedAt: new Date().toISOString(),
    indexRange: [options['from-index'], options['to-index']],
    sourceSmallFileHashes: before,
    sourceZip: {
      size: zipBefore.size,
      mtimeMs: zipBefore.mtimeMs,
      note: 'size and mtime only; not a full ZIP hash',
    },
    backendHashes,
    samples: [],
  };
  const client = new BridgeClient(executable);
  try {
    const loaded = await client.call('load', { dataDir: data, zipPath: options.zip });
    if (options['to-index'] > loaded.treeCount)
      throw new Error(`Index exceeds tree count: ${loaded.treeCount}`);
    await client.call('view.options', { frameStrategy: 'quality', dualFrame: true });
    for (let index = options['from-index']; index <= options['to-index']; index++) {
      const state = await client.call('tree.select', { index });
      // One serial request returns both photos, marker and frame identity atomically.
      const snapshot = await client.call('photo.snapshot');
      const sample = snapshotSample(
        options.dataset,
        index,
        state,
        snapshot,
        cleanDir,
        markedDir,
        modelSha256,
      );
      sample.dualEvidence = { state: 'unavailable', reason: 'not_success' };
      if (sample.dual.state === 'success') {
        let raw;
        try {
          raw = await client.call('dual.evidence');
        } catch (error) {
          if (!/不支持的操作/.test(error.message)) throw error;
          raw = null;
        }
        if (raw === null)
          sample.dualEvidence = { state: 'unavailable', reason: 'endpoint_unavailable' };
        else
          sample.dualEvidence = storePairEvidence(
            validateDualEvidence(raw, snapshot),
            index,
            path.join(output, 'evidence'),
          );
      }
      predictions.samples.push(sample);
      if (index % 10 === 0 || index === options['to-index'])
        console.log(`Collected ${index}/${options['to-index']}`);
    }
  } finally {
    const closed =
      client.child.exitCode === null && client.child.signalCode === null
        ? once(client.child, 'close')
        : Promise.resolve();
    client.close();
    await closed;
  }
  const after = smallInputHashes(options.data);
  const finalModelHash = fs.existsSync(modelPath) ? sha256(fs.readFileSync(modelPath)) : null;
  const zipAfter = fs.statSync(options.zip);
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    modelSha256 !== finalModelHash ||
    zipBefore.size !== zipAfter.size ||
    zipBefore.mtimeMs !== zipAfter.mtimeMs
  ) {
    throw new Error('Original input changed during collection; evidence was not finalized');
  }
  const labels = {
    schema: LABEL_SCHEMA,
    dataset: options.dataset,
    labels: predictions.samples.map(emptyLabel),
  };
  writeJson(path.join(output, 'evidence', 'predictions.json'), predictions);
  writeJson(path.join(output, 'labels', 'labels-template.json'), labels);
  console.log(`Collection: ${output}`);
  console.log(`Isolated working copy: ${work}`);
  console.log('No ground truth has been created; all review fields are null.');
  const invalid = predictions.samples.filter(
    (sample) => sample.peopleDetection.status === 'invalid',
  ).length;
  const incomplete = predictions.samples.filter(
    (sample) => sample.peopleDetection.status !== 'complete',
  ).length;
  const pairMissing = predictions.samples.filter(
    (sample) => sample.dual.state === 'success' && sample.dualEvidence.state !== 'available',
  ).length;
  const successful = predictions.samples.filter((sample) => sample.dual.state === 'success').length;
  console.log(
    `Winning pair evidence: ${successful - pairMissing}/${successful}; no successes means not evaluated.`,
  );
  if (
    invalid ||
    (options['require-model'] === 'true' && incomplete) ||
    (options['require-evidence'] === 'true' && pairMissing)
  ) {
    console.error(`Detector evidence incomplete: ${incomplete}; invalid: ${invalid}`);
    if (pairMissing) console.error(`Winning pair evidence unavailable: ${pairMissing}`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try {
    collect(parseArguments(process.argv.slice(2))).catch((error) => {
      console.error(`Collection failed: ${error.message}`);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(`Collection failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, readJpegDataUrl, mapPeopleDetection, snapshotSample, collect };
