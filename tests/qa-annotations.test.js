'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  PREDICTION_SCHEMA,
  LABEL_SCHEMA,
  sha256,
  jpegDimensions,
  emptyLabel,
  evaluate,
} = require('./qa-annotations');
const { parseArguments, snapshotSample, mapPeopleDetection } = require('./qa-collect-annotations');
const { decodeAnalysisPng } = require('./qa-png-evidence');

const blank = path.join(__dirname, 'fixtures', 'qa-blank-100x50.jpg');
const blankBytes = fs.readFileSync(blank);

function image(file, bytes, kind = 'clean') {
  return { path: file, sha256: sha256(bytes), width: 100, height: 50, kind };
}

function sample(id, overrides = {}) {
  return {
    sampleId: `D:${id}`,
    treeId: id,
    frameA: `a-${id}.jpg`,
    image: image(blank, blankBytes),
    predictedPoint: { x: 0.6, y: 0.6 },
    markSource: 'automatic',
    dual: { state: 'fallback', frameB: null },
    peoplePrediction: { person: 'unknown', head: 'unknown', scalp: 'unknown' },
    ...overrides,
  };
}

function docs(samples) {
  const backendHashes = {
    'models/person_head.onnx': 'a'.repeat(64),
    'models/scalp.onnx': 'b'.repeat(64),
  };
  for (const value of samples) {
    const prediction = value.peoplePrediction;
    if (prediction.person !== 'unknown' || prediction.head !== 'unknown') {
      value.peopleDetection = {
        status: 'complete',
        model: 'synthetic-test',
        modelSha256: backendHashes['models/person_head.onnx'],
        scoreThreshold: 0.25,
        predictions: { person: prediction.person, head: prediction.head, scalp: 'unknown' },
      };
    }
    if (prediction.scalp !== 'unknown') {
      value.scalpDetection = {
        status: 'complete',
        model: 'synthetic-scalp-test',
        modelSha256: backendHashes['models/scalp.onnx'],
        scoreThreshold: 0.25,
        prediction: prediction.scalp,
      };
    }
  }
  return [
    { schema: PREDICTION_SCHEMA, dataset: 'D', backendHashes, samples },
    { schema: LABEL_SCHEMA, dataset: 'D', labels: samples.map(emptyLabel) },
  ];
}

function reviewed(value, fields = {}) {
  return { ...value, reviewer: 'reviewer-1', reviewMethod: 'blind', ...fields };
}

function run(predictions, labels) {
  return evaluate(predictions, labels, __dirname, __dirname);
}

test('JPEG header and hash are verified; invalid or changed bytes do not silently pass', () => {
  assert.deepEqual(jpegDimensions(blankBytes), { width: 100, height: 50 });
  assert.throws(() => jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), /dimensions/);
  const [predictions, labels] = docs([sample(1)]);
  predictions.samples[0].image.sha256 = '0'.repeat(64);
  labels.labels[0].imageSha256 = '0'.repeat(64);
  assert.throws(() => run(predictions, labels), /SHA-256 mismatch/);
  predictions.samples[0].image.sha256 = sha256(blankBytes);
  predictions.samples[0].image.width = 101;
  assert.throws(() => run(predictions, labels), /dimensions mismatch/);
  predictions.samples[0].image.width = 100;
  predictions.samples[0].image.path = path.join(__dirname, 'fixtures', 'qa-blue-100x50.jpg');
  assert.throws(() => run(predictions, labels), /SHA-256 mismatch/);
});

test('unlabeled samples are explicitly not evaluated, not zero error or 100% success', () => {
  const [predictions, labels] = docs([
    sample(1, { dual: { state: 'success', frameB: 'b-1.jpg' } }),
    sample(2),
  ]);
  const report = run(predictions, labels);
  assert.equal(report.counts.noLabel, 2);
  assert.equal(report.pointError.all.status, 'not_evaluated');
  assert.equal(report.pointError.all.meanPx, null);
  assert.equal(report.dual.successRateAmongAttempts, 0.5);
  assert.equal(report.dual.missingPairReview, 1);
  assert.equal(report.dual.sameTreeRateAmongReviewedSuccesses, null);
  assert.equal(report.person.status, 'not_evaluated');
  assert.equal(report.scalp.sensitivityAmongClassifiedPositives, null);
});

test('normalized coordinates use actual width and height; out-of-frame predictions are not clamped', () => {
  const [predictions, labels] = docs([
    sample(1),
    sample(2, { predictedPoint: { x: 1.2, y: 0.5 } }),
  ]);
  labels.labels[0] = reviewed(labels.labels[0], {
    targetVisible: true,
    trunkCenter: { x: 0.5, y: 0.4 },
  });
  labels.labels[1] = reviewed(labels.labels[1], {
    targetVisible: true,
    trunkCenter: { x: 1, y: 0.5 },
  });
  const report = run(predictions, labels);
  assert.ok(Math.abs(report.details[0].errorPx - Math.sqrt(200)) < 1e-10);
  assert.ok(Math.abs(report.details[1].errorPx - 20) < 1e-10);
  assert.equal(report.pointError.blind.count, 2);
  assert.equal(report.pointError.automatic.count, 2);
});

test('human-corrected marks never count as blind automatic algorithm evidence', () => {
  const [predictions, labels] = docs([
    sample(1, { markSource: 'manual', dual: { state: 'manual', frameB: null } }),
  ]);
  labels.labels[0] = reviewed(labels.labels[0], {
    targetVisible: true,
    trunkCenter: { x: 0.5, y: 0.5 },
  });
  const report = run(predictions, labels);
  assert.equal(report.pointError.blind.count, 1);
  assert.equal(report.pointError.manual.count, 1);
  assert.equal(report.pointError.blindAutomatic.count, 0);
});

test('non-blind human reviews never count toward blind detector evidence', () => {
  const [predictions, labels] = docs([
    sample(1, { peoplePrediction: { person: 'present', head: 'absent', scalp: 'unknown' } }),
  ]);
  labels.labels[0] = reviewed(labels.labels[0], {
    reviewMethod: 'prediction_visible',
    personVisible: true,
  });
  const report = run(predictions, labels);
  assert.equal(report.person.classified, 1);
  assert.equal(report.personBlind.classified, 0);
  assert.equal(report.personBlind.status, 'not_evaluated');
});

test('label identity, absent reference and review provenance are mandatory', () => {
  const [predictions, labels] = docs([sample(1)]);
  labels.labels[0].imageSha256 = '0'.repeat(64);
  assert.throws(() => run(predictions, labels), /label image identity mismatch/);
  labels.labels[0] = reviewed(emptyLabel(predictions.samples[0]), {
    targetVisible: false,
    trunkCenter: { x: 0.5, y: 0.5 },
  });
  assert.throws(() => run(predictions, labels), /requires a visible target/);
  labels.labels[0].targetVisible = true;
  labels.labels[0].reviewer = null;
  assert.throws(() => run(predictions, labels), /reviewer/);
  labels.labels[0].reviewer = 'reviewer-1';
  predictions.samples[0].image.kind = 'marked';
  assert.throws(() => run(predictions, labels), /marked image cannot be a blind reference/);
  labels.labels[0].reviewMethod = 'prediction_visible';
  assert.equal(run(predictions, labels).pointError.prediction_visible.count, 1);
});

test('pair accuracy requires both actual winning candidates and their frame/attempt/hash identities', () => {
  const [predictions, labels] = docs([
    sample(1, { dual: { state: 'success', frameB: 'b-1.jpg' } }),
  ]);
  const original = predictions.samples[0];
  const cleanPath = path.join(__dirname, 'fixtures', 'qa-rgba-2x2.png');
  const markedPath = path.join(__dirname, 'fixtures', 'qa-rgba-marked-2x2.png');
  const cleanPng = fs.readFileSync(cleanPath),
    markedPng = fs.readFileSync(markedPath);
  const cleanInfo = {
    path: cleanPath,
    fileSha256: sha256(cleanPng),
    ...decodeAnalysisPng(cleanPng),
  };
  const markedInfo = {
    path: markedPath,
    fileSha256: sha256(markedPng),
    ...decodeAnalysisPng(markedPng),
  };
  const observation = (frame) => ({
    frame,
    azimuthDeg: 12,
    elevationTopDeg: 8,
    elevationBottomDeg: 1,
    widthDeg: 2,
    azimuthOriginDeg: 0,
    verticalCalibrationDeg: 0,
    x: 0.4,
    yTop: 0.2,
    yBottom: 0.8,
    width: 2,
    height: 2,
    analysisPixelSha256: cleanInfo.pixelSha256,
  });
  original.treeIndex = 1;
  original.dualDiagnostics = {
    state: 'success',
    frameA: 'a-1.jpg',
    frameB: 'b-1.jpg',
    attempts: 1,
  };
  original.dualEvidence = {
    state: 'available',
    reason: 'success_pair_observations_not_identity',
    treeId: 1,
    treeIndex: 1,
    frameA: 'a-1.jpg',
    frameB: 'b-1.jpg',
    attempt: 1,
    hashFormat: 'sha256-wh32le-topdown-bgra32-v1',
    observationA: observation('a-1.jpg'),
    observationB: observation('b-1.jpg'),
    images: {
      panoA: { ...cleanInfo },
      panoAMarked: { ...markedInfo },
      panoB: { ...cleanInfo },
      panoBMarked: { ...markedInfo },
    },
  };
  const pair = {
    frameA: 'a-1.jpg',
    frameB: 'b-1.jpg',
    attempt: 1,
    sameTree: true,
    bothAreTarget: true,
    candidateVisible: true,
    reviewer: 'pair-reviewer-1',
    reviewMethod: 'candidate_visible',
    markedASha256: markedInfo.fileSha256,
    markedBSha256: markedInfo.fileSha256,
  };
  labels.labels[0] = { ...labels.labels[0], pair };
  let report = run(predictions, labels);
  assert.equal(report.dual.sameTreeRateAmongReviewedSuccesses, 1);
  assert.equal(report.dual.targetRateAmongReviewedSuccesses, 1);
  assert.equal(report.counts.blind, 0);
  assert.equal(report.pointError.blindAutomatic.status, 'not_evaluated');
  pair.frameB = 'wrong.jpg';
  assert.throws(() => run(predictions, labels), /frame or attempt mismatch/);
  pair.frameB = 'b-1.jpg';
  pair.candidateVisible = false;
  assert.throws(() => run(predictions, labels), /both winning candidates/);
  pair.candidateVisible = true;
  pair.markedASha256 = '0'.repeat(64);
  assert.throws(() => run(predictions, labels), /annotated image SHA-256 mismatch/);
  pair.markedASha256 = markedInfo.fileSha256;
  original.dualEvidence.images.panoB.fileSha256 = '0'.repeat(64);
  assert.throws(() => run(predictions, labels), /stored PNG SHA-256 mismatch/);
  original.dualEvidence.images.panoB.fileSha256 = cleanInfo.fileSha256;
  pair.sameTree = false;
  assert.throws(() => run(predictions, labels), /contradictory/);
  pair.bothAreTarget = false;
  report = run(predictions, labels);
  assert.equal(report.dual.confirmedDifferent, 1);
  assert.equal(report.dual.confirmedNotTarget, 1);
});

test('person, head and scalp metrics account for unknown predictions separately', () => {
  const [predictions, labels] = docs([
    sample(1, { peoplePrediction: { person: 'present', head: 'present', scalp: 'absent' } }),
    sample(2, { peoplePrediction: { person: 'absent', head: 'absent', scalp: 'absent' } }),
    sample(3),
    sample(4),
  ]);
  labels.labels[0] = reviewed(labels.labels[0], {
    personVisible: true,
    headVisible: true,
    scalpVisible: false,
  });
  labels.labels[1] = reviewed(labels.labels[1], {
    personVisible: true,
    headVisible: true,
    scalpVisible: true,
  });
  labels.labels[2] = reviewed(labels.labels[2], {
    personVisible: false,
    headVisible: false,
    scalpVisible: false,
  });
  labels.labels[3] = reviewed(labels.labels[3], {
    personVisible: true,
    headVisible: true,
    scalpVisible: true,
  });
  const report = run(predictions, labels);
  assert.equal(report.person.truePositive, 1);
  assert.equal(report.person.falseNegative, 1);
  assert.equal(report.person.unknownPrediction, 2);
  assert.equal(report.person.coverage, 2 / 4);
  assert.equal(report.person.unknownPositive, 1);
  assert.equal(report.person.unknownNegative, 1);
  assert.equal(report.person.sensitivityLowerBound, 1 / 3);
  assert.equal(report.person.sensitivityUpperBound, 2 / 3);
  assert.equal(report.head.truePositive, 1);
  assert.equal(report.head.falseNegative, 1);
  assert.equal(report.scalp.falseNegative, 1);
  labels.labels[2].scalpVisible = true;
  assert.throws(() => run(predictions, labels), /scalp\/person labels conflict/);
});

test('positive or negative detection requires matching model provenance', () => {
  const [predictions, labels] = docs([
    sample(1, { peoplePrediction: { person: 'present', head: 'absent', scalp: 'unknown' } }),
  ]);
  assert.equal(run(predictions, labels).person.unlabeled, 1);
  predictions.samples[0].peopleDetection.modelSha256 = 'f'.repeat(64);
  assert.throws(() => run(predictions, labels), /model evidence/);
  predictions.samples[0].peopleDetection.modelSha256 =
    predictions.backendHashes['models/person_head.onnx'];
  predictions.samples[0].peopleDetection.predictions.person = 'absent';
  assert.throws(() => run(predictions, labels), /does not match/);
  predictions.samples[0].peoplePrediction = { person: 'absent', head: 'present', scalp: 'unknown' };
  assert.throws(() => run(predictions, labels), /head\/person model predictions conflict/);
  predictions.samples[0].peoplePrediction = {
    person: 'unknown',
    head: 'unknown',
    scalp: 'present',
  };
  delete predictions.samples[0].peopleDetection;
  assert.throws(() => run(predictions, labels), /scalpDetection/);
});

test('duplicate, orphan, wrong dataset and out-of-frame reference labels fail closed', () => {
  const [predictions, labels] = docs([sample(1)]);
  labels.labels.push({ ...labels.labels[0] });
  assert.throws(() => run(predictions, labels), /Duplicate label/);
  labels.labels.pop();
  labels.dataset = 'other';
  assert.throws(() => run(predictions, labels), /Dataset mismatch/);
  labels.dataset = 'D';
  labels.labels.push({ ...labels.labels[0], sampleId: 'not-in-run' });
  assert.throws(() => run(predictions, labels), /Labels without predictions/);
  labels.labels.pop();
  labels.labels[0] = reviewed(labels.labels[0], {
    targetVisible: true,
    trunkCenter: { x: -0.1, y: 0.5 },
  });
  assert.throws(() => run(predictions, labels), /outside the image/);
});

test('CLI evidence minimums fail with exit 2 and never overwrite an existing report', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-qa-eval-test-'));
  const [predictions, labels] = docs([sample(1)]);
  const predictionsFile = path.join(temporary, 'predictions.json');
  const labelsFile = path.join(temporary, 'labels.json');
  const reportFile = path.join(temporary, 'report.json');
  fs.writeFileSync(predictionsFile, JSON.stringify(predictions));
  const labelsBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(labels)),
  ]);
  fs.writeFileSync(labelsFile, labelsBytes);
  const args = [
    path.join(__dirname, 'qa-evaluate-annotations.js'),
    '--predictions',
    predictionsFile,
    '--labels',
    labelsFile,
    '--output',
    reportFile,
    '--min-blind-points',
    '1',
  ];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 2, first.stderr);
  const priorReport = fs.readFileSync(reportFile, 'utf8');
  const parsed = JSON.parse(priorReport);
  assert.equal(parsed.pointError.blind.status, 'not_evaluated');
  assert.equal(parsed.provenance.labelsSha256, sha256(labelsBytes));
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(second.status, 1);
  assert.equal(fs.readFileSync(reportFile, 'utf8'), priorReport);
});

test('atomic snapshot collection preserves clean/marked identity and does not infer person absence', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-qa-capture-test-'));
  const cleanDir = path.join(temporary, 'clean');
  const markedDir = path.join(temporary, 'marked');
  fs.mkdirSync(cleanDir);
  fs.mkdirSync(markedDir);
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'qa-blank-120x90.jpg'));
  const url = 'data:image/jpeg;base64,' + bytes.toString('base64');
  const state = { treeId: 77, frame: 'a.jpg' };
  const snapshot = {
    treeId: 77,
    treeIndex: 12,
    frame: 'a.jpg',
    width: 120,
    height: 90,
    photoClean: url,
    photoMarked: url,
    photoMarkNormalized: { x: 1.1, y: 0.5, inFrame: false },
    dualFrameInfo: { state: 'fallback', frameB: '' },
    photoRisk: { state: 'unverified' },
  };
  const result = snapshotSample('D', 12, state, snapshot, cleanDir, markedDir);
  assert.equal(result.image.sha256, sha256(bytes));
  assert.deepEqual(result.predictedPoint, { x: 1.1, y: 0.5 });
  assert.deepEqual(result.peoplePrediction, {
    person: 'unknown',
    head: 'unknown',
    scalp: 'unknown',
  });
  assert.equal(fs.readFileSync(path.join(cleanDir, '000012-clean.jpg')).equals(bytes), true);
  assert.throws(
    () =>
      snapshotSample('D', 12, { ...state, frame: 'different.jpg' }, snapshot, cleanDir, markedDir),
    /identity changed/,
  );
  assert.throws(
    () =>
      snapshotSample(
        'D',
        13,
        state,
        { ...snapshot, treeIndex: 13, photoMarkNormalized: { x: 1.1, y: 0.5, inFrame: true } },
        cleanDir,
        markedDir,
      ),
    /invalid normalized marker/,
  );
  assert.throws(
    () =>
      snapshotSample(
        'D',
        14,
        state,
        { ...snapshot, treeIndex: 14, width: 100 },
        cleanDir,
        markedDir,
      ),
    /dimensions differ/,
  );
  assert.throws(
    () =>
      snapshotSample(
        'D',
        15,
        state,
        { ...snapshot, treeIndex: 15, photoClean: null },
        cleanDir,
        markedDir,
      ),
    /missing JPEG/,
  );
});

test('collector rejects missing options, repeated values and invalid index ranges', () => {
  const good = [
    '--dataset',
    'D1',
    '--data',
    '.',
    '--zip',
    'a.zip',
    '--bridge',
    'b.exe',
    '--from-index',
    '120',
    '--to-index',
    '170',
  ];
  assert.equal(parseArguments(good)['from-index'], 120);
  assert.equal(parseArguments([...good, '--require-model', 'true'])['require-model'], 'true');
  assert.throws(() => parseArguments([...good, '--require-model', 'yes']), /must be true or false/);
  assert.throws(() => parseArguments([...good, '--dataset', 'D1']), /Repeated/);
  assert.throws(() => parseArguments(good.slice(0, -2)), /Missing/);
  assert.throws(() => parseArguments([...good.slice(0, -1), '2']), /Invalid index range/);
});

test('model decisions fail closed; head detection is never mapped to scalp', () => {
  const unknown = { person: 'unknown', head: 'unknown', scalp: 'unknown' };
  const modelHash = 'a'.repeat(64);
  const complete = {
    status: 'complete',
    personDetected: true,
    headDetected: false,
    scalpDetected: null,
    model: 'local-model',
    modelSha256: modelHash.toUpperCase(),
    scoreThreshold: 0.25,
    error: null,
  };
  assert.deepEqual(mapPeopleDetection(complete, true, modelHash).predictions, {
    person: 'present',
    head: 'absent',
    scalp: 'unknown',
  });
  assert.equal(mapPeopleDetection(complete, true, modelHash).status, 'complete');
  const headOnly = mapPeopleDetection(
    { ...complete, personDetected: true, headDetected: true },
    true,
    modelHash,
  );
  assert.deepEqual(headOnly.predictions, { person: 'present', head: 'present', scalp: 'unknown' });
  const contradictory = mapPeopleDetection(
    { ...complete, personDetected: false, headDetected: true },
    true,
    modelHash,
  );
  assert.equal(contradictory.status, 'invalid');
  assert.deepEqual(contradictory.predictions, unknown);
  assert.deepEqual(mapPeopleDetection(undefined, true).predictions, unknown);
  assert.deepEqual(mapPeopleDetection(complete, false, modelHash).predictions, unknown);
  assert.equal(mapPeopleDetection(complete, true, 'b'.repeat(64)).reason, 'model_hash_mismatch');
  assert.deepEqual(mapPeopleDetection(complete, true).predictions, unknown);
  assert.deepEqual(
    mapPeopleDetection({ ...complete, personDetected: null }, true, modelHash).predictions,
    unknown,
  );
  assert.deepEqual(
    mapPeopleDetection({ ...complete, scalpDetected: false }, true, modelHash).predictions,
    unknown,
  );
  assert.deepEqual(
    mapPeopleDetection({ ...complete, scoreThreshold: 1.1 }, true, modelHash).predictions,
    unknown,
  );
  assert.deepEqual(
    mapPeopleDetection({ ...complete, model: '' }, true, modelHash).predictions,
    unknown,
  );
  assert.deepEqual(
    mapPeopleDetection({ ...complete, error: 'error' }, true, modelHash).predictions,
    unknown,
  );
  assert.equal(
    mapPeopleDetection(
      { status: 'unavailable', personDetected: false, headDetected: null, scalpDetected: null },
      true,
    ).status,
    'invalid',
  );
  assert.equal(
    mapPeopleDetection(
      { status: 'unavailable', personDetected: null, headDetected: null, scalpDetected: null },
      true,
    ).status,
    'unavailable',
  );
});
