'use strict';

// Independent ground-truth evaluator. Input photos are read-only and must match
// their recorded SHA-256, dimensions, tree and frame. No label is inferred.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateStoredEvidence } = require('./qa-dual-evidence-validation');

const PREDICTION_SCHEMA = 'treeextract.predictions.v1';
const LABEL_SCHEMA = 'treeextract.labels.v1';
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const DUAL_STATES = new Set([
  'success',
  'fallback',
  'manual',
  'disabled',
  'not_run',
  'unavailable',
]);
const DECISIONS = new Set(['present', 'absent', 'unknown']);

function fail(message) {
  throw new Error(message);
}

function object(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${context}: expected object`);
  return value;
}

function nonempty(value, context) {
  if (typeof value !== 'string' || !value.trim()) fail(`${context}: expected non-empty string`);
  return value;
}

function nullableBoolean(value, context) {
  if (value !== null && typeof value !== 'boolean')
    fail(`${context}: expected true, false or null`);
  return value;
}

function point(value, context, reference) {
  if (value === null) return null;
  object(value, context);
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y))
    fail(`${context}: invalid coordinates`);
  if (reference && (value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1)) {
    fail(`${context}: reference point is outside the image`);
  }
  return { x: value.x, y: value.y };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Read dimensions from a JPEG SOF header; this is not a full image decode.
function jpegDimensions(bytes) {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    fail('Invalid JPEG boundaries');
  }
  const sof = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) fail('Invalid JPEG marker');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) fail('Incomplete JPEG segment');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) fail('Invalid JPEG segment length');
    if (sof.has(marker)) {
      if (length < 8) fail('Incomplete JPEG dimensions');
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height) fail('Invalid JPEG dimensions');
      return { width, height };
    }
    offset += length;
  }
  fail('JPEG dimensions not found');
}

function verifyImage(image, baseDirectory, context) {
  object(image, context);
  nonempty(image.path, `${context}.path`);
  if (typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256)) {
    fail(`${context}: invalid SHA-256`);
  }
  if (
    !Number.isSafeInteger(image.width) ||
    image.width <= 0 ||
    !Number.isSafeInteger(image.height) ||
    image.height <= 0
  ) {
    fail(`${context}: invalid dimensions`);
  }
  const file = path.resolve(baseDirectory, image.path);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) fail(`${context}: invalid file or size`);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== image.sha256) fail(`${context}: image SHA-256 mismatch`);
  const actual = jpegDimensions(bytes);
  if (actual.width !== image.width || actual.height !== image.height) {
    fail(`${context}: image dimensions mismatch`);
  }
  return actual;
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function summarizeErrors(values) {
  if (!values.length)
    return {
      status: 'not_evaluated',
      count: 0,
      meanPx: null,
      medianPx: null,
      p90Px: null,
      p95Px: null,
    };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    status: 'evaluated',
    count: values.length,
    meanPx: values.reduce((mean, value, index) => mean + (value - mean) / (index + 1), 0),
    medianPx: percentile(sorted, 0.5),
    p90Px: percentile(sorted, 0.9),
    p95Px: percentile(sorted, 0.95),
  };
}

function newRiskStats() {
  return {
    labeled: 0,
    truePositive: 0,
    falsePositive: 0,
    trueNegative: 0,
    falseNegative: 0,
    unknownPrediction: 0,
    unknownPositive: 0,
    unknownNegative: 0,
    unlabeled: 0,
  };
}

function updateRisk(stats, truth, decision) {
  if (truth === null) {
    stats.unlabeled++;
    return;
  }
  stats.labeled++;
  if (decision === 'unknown') {
    stats.unknownPrediction++;
    if (truth) stats.unknownPositive++;
    else stats.unknownNegative++;
    return;
  }
  if (truth && decision === 'present') stats.truePositive++;
  if (truth && decision === 'absent') stats.falseNegative++;
  if (!truth && decision === 'present') stats.falsePositive++;
  if (!truth && decision === 'absent') stats.trueNegative++;
}

function finishRisk(stats) {
  const classified =
    stats.truePositive + stats.falsePositive + stats.trueNegative + stats.falseNegative;
  const status = !classified
    ? 'not_evaluated'
    : classified === stats.labeled
      ? 'evaluated'
      : 'partially_evaluated';
  return {
    ...stats,
    status,
    classified,
    coverage: rate(classified, stats.labeled),
    sensitivityAmongClassifiedPositives: rate(
      stats.truePositive,
      stats.truePositive + stats.falseNegative,
    ),
    specificityAmongClassifiedNegatives: rate(
      stats.trueNegative,
      stats.trueNegative + stats.falsePositive,
    ),
    sensitivityLowerBound: rate(
      stats.truePositive,
      stats.truePositive + stats.falseNegative + stats.unknownPositive,
    ),
    sensitivityUpperBound: rate(
      stats.truePositive + stats.unknownPositive,
      stats.truePositive + stats.falseNegative + stats.unknownPositive,
    ),
    specificityLowerBound: rate(
      stats.trueNegative,
      stats.trueNegative + stats.falsePositive + stats.unknownNegative,
    ),
    specificityUpperBound: rate(
      stats.trueNegative + stats.unknownNegative,
      stats.trueNegative + stats.falsePositive + stats.unknownNegative,
    ),
    // Unknown predictions are not silently treated as true negatives or successes.
  };
}

function emptyLabel(sample) {
  return {
    sampleId: sample.sampleId,
    treeId: sample.treeId,
    frameA: sample.frameA,
    imageSha256: sample.image ? sample.image.sha256 : null,
    width: sample.image ? sample.image.width : null,
    height: sample.image ? sample.image.height : null,
    reviewer: null,
    reviewMethod: null,
    targetVisible: null,
    trunkCenter: null,
    personVisible: null,
    headVisible: null,
    scalpVisible: null,
    pair: null,
  };
}

function isPrimaryReviewed(label) {
  return (
    label.targetVisible !== null ||
    label.trunkCenter !== null ||
    label.personVisible !== null ||
    label.headVisible !== null ||
    label.scalpVisible !== null
  );
}

function isReviewed(label) {
  return isPrimaryReviewed(label) || label.pair !== null;
}

function validatePair(pair, sample, verifiedEvidence, context) {
  if (pair === null) return null;
  object(pair, context);
  if (sample.dual.state !== 'success' || !sample.dual.frameB) {
    fail(`${context}: pair review requires a successful pair with frame B`);
  }
  if (!verifiedEvidence) fail(`${context}: actual A/B winning pair evidence is unavailable`);
  if (
    pair.frameA !== verifiedEvidence.frameA ||
    pair.frameB !== verifiedEvidence.frameB ||
    pair.attempt !== verifiedEvidence.attempt
  )
    fail(`${context}: frame or attempt mismatch`);
  nullableBoolean(pair.sameTree, `${context}.sameTree`);
  nullableBoolean(pair.bothAreTarget, `${context}.bothAreTarget`);
  nonempty(pair.reviewer, `${context}.reviewer`);
  if (pair.reviewMethod !== 'candidate_visible')
    fail(`${context}: pair review provenance is required`);
  if (pair.sameTree === null && pair.bothAreTarget === null) fail(`${context}: no pair assessment`);
  if (pair.sameTree !== true && pair.bothAreTarget === true)
    fail(`${context}: contradictory assessment`);
  if (pair.candidateVisible !== true) fail(`${context}: both winning candidates must be visible`);
  if (
    pair.markedASha256 !== verifiedEvidence.images.panoAMarked.fileSha256 ||
    pair.markedBSha256 !== verifiedEvidence.images.panoBMarked.fileSha256
  ) {
    fail(`${context}: annotated image SHA-256 mismatch`);
  }
  return pair;
}

function validateModelSource(detector, hashes, modelFile, context) {
  object(detector, context);
  const hash = hashes && hashes[modelFile];
  if (
    detector.status !== 'complete' ||
    typeof detector.model !== 'string' ||
    !detector.model.trim() ||
    typeof detector.modelSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(detector.modelSha256) ||
    detector.modelSha256 !== hash ||
    !Number.isFinite(detector.scoreThreshold) ||
    detector.scoreThreshold < 0 ||
    detector.scoreThreshold > 1
  ) {
    fail(`${context}: missing or inconsistent model evidence`);
  }
}

function validatePeopleSources(sample, predictions) {
  const decision = sample.peoplePrediction;
  const context = sample.sampleId;
  const needsPeople = decision.person !== 'unknown' || decision.head !== 'unknown';
  const needsScalp = decision.scalp !== 'unknown';
  if ((needsPeople || needsScalp) && !sample.image) fail(`${context}: detection without a photo`);
  if (decision.head === 'present' && decision.person === 'absent') {
    fail(`${context}: head/person model predictions conflict`);
  }
  if (sample.peopleDetection && sample.peopleDetection.status === 'complete' && !needsPeople) {
    fail(`${context}: complete detector lacks explicit person/head predictions`);
  }
  if (needsPeople) {
    if (decision.person === 'unknown' || decision.head === 'unknown') {
      fail(`${context}: complete detector requires both person and head predictions`);
    }
    validateModelSource(
      sample.peopleDetection,
      predictions.backendHashes,
      'models/person_head.onnx',
      `${context}.peopleDetection`,
    );
    const original = object(
      sample.peopleDetection.predictions,
      `${context}.peopleDetection.predictions`,
    );
    if (
      original.person !== decision.person ||
      original.head !== decision.head ||
      original.scalp !== 'unknown'
    ) {
      fail(`${context}: people prediction does not match detector evidence`);
    }
  }
  if (needsScalp) {
    validateModelSource(
      sample.scalpDetection,
      predictions.backendHashes,
      'models/scalp.onnx',
      `${context}.scalpDetection`,
    );
    if (sample.scalpDetection.prediction !== decision.scalp)
      fail(`${context}: scalp prediction does not match detector evidence`);
  }
}

function evaluate(predictions, labels, predictionBase, labelBase) {
  object(predictions, 'predictions');
  object(labels, 'labels');
  if (predictions.schema !== PREDICTION_SCHEMA || labels.schema !== LABEL_SCHEMA)
    fail('Schema mismatch');
  nonempty(predictions.dataset, 'predictions.dataset');
  if (predictions.dataset !== labels.dataset) fail('Dataset mismatch');
  if (!Array.isArray(predictions.samples) || !Array.isArray(labels.labels))
    fail('Samples and labels must be arrays');
  const labelsById = new Map();
  for (const value of labels.labels) {
    object(value, 'label');
    nonempty(value.sampleId, 'label.sampleId');
    if (labelsById.has(value.sampleId)) fail(`Duplicate label: ${value.sampleId}`);
    labelsById.set(value.sampleId, value);
  }
  const seen = new Set();
  const errors = {
    all: [],
    blind: [],
    blindAutomatic: [],
    blindDualSuccess: [],
    prediction_visible: [],
    automatic: [],
    manual: [],
    dualSuccess: [],
    dualFallback: [],
  };
  const person = newRiskStats();
  const head = newRiskStats();
  const scalp = newRiskStats();
  const personBlind = newRiskStats();
  const headBlind = newRiskStats();
  const scalpBlind = newRiskStats();
  const detectionStatus = { complete: 0, unavailable: 0, invalid: 0, unknown: 0 };
  const dual = {
    success: 0,
    fallback: 0,
    other: 0,
    reviewedSame: 0,
    confirmedSame: 0,
    confirmedDifferent: 0,
    reviewedTarget: 0,
    confirmedTarget: 0,
    confirmedNotTarget: 0,
    missingPairReview: 0,
    evidenceAvailable: 0,
    evidenceUnavailable: 0,
  };
  const counts = {
    total: 0,
    missingPhoto: 0,
    noLabel: 0,
    labeled: 0,
    targetVisible: 0,
    targetNotVisible: 0,
    targetUnknown: 0,
    missingReferencePoint: 0,
    missingPredictionPoint: 0,
    blind: 0,
    predictionVisible: 0,
  };
  const details = [];

  for (const sample of predictions.samples) {
    object(sample, 'sample');
    nonempty(sample.sampleId, 'sample.sampleId');
    if (seen.has(sample.sampleId)) fail(`Duplicate sample: ${sample.sampleId}`);
    seen.add(sample.sampleId);
    counts.total++;
    if (!Number.isSafeInteger(sample.treeId)) fail(`${sample.sampleId}: invalid tree ID`);
    if (typeof sample.frameA !== 'string') fail(`${sample.sampleId}: invalid frame A`);
    object(sample.dual, `${sample.sampleId}.dual`);
    if (!DUAL_STATES.has(sample.dual.state)) fail(`${sample.sampleId}: invalid dual state`);
    if (sample.dual.frameB !== null && typeof sample.dual.frameB !== 'string')
      fail(`${sample.sampleId}: invalid frame B`);
    if (sample.dual.state === 'success' && !sample.dual.frameB)
      fail(`${sample.sampleId}: success lacks frame B`);
    if (sample.dual.state === 'success') dual.success++;
    else if (sample.dual.state === 'fallback') dual.fallback++;
    else dual.other++;
    if (sample.image === null) counts.missingPhoto++;
    else {
      nonempty(sample.frameA, `${sample.sampleId}.frameA`);
      verifyImage(sample.image, predictionBase, `${sample.sampleId}.image`);
      if (!['clean', 'marked'].includes(sample.image.kind))
        fail(`${sample.sampleId}: image kind required`);
    }
    const predicted = point(sample.predictedPoint, `${sample.sampleId}.predictedPoint`, false);
    if (sample.image === null && predicted !== null)
      fail(`${sample.sampleId}: mark without a photo`);
    if (!['automatic', 'manual', 'unknown'].includes(sample.markSource))
      fail(`${sample.sampleId}: invalid mark source`);
    object(sample.peoplePrediction, `${sample.sampleId}.peoplePrediction`);
    for (const key of ['person', 'head', 'scalp'])
      if (!DECISIONS.has(sample.peoplePrediction[key]))
        fail(`${sample.sampleId}: invalid ${key} prediction`);
    validatePeopleSources(sample, predictions);
    const detectionState = sample.peopleDetection && sample.peopleDetection.status;
    if (
      detectionState === 'complete' ||
      detectionState === 'unavailable' ||
      detectionState === 'invalid'
    ) {
      detectionStatus[detectionState]++;
    } else detectionStatus.unknown++;
    const label = labelsById.get(sample.sampleId) || emptyLabel(sample);
    labelsById.delete(sample.sampleId);
    if (label.treeId !== sample.treeId || label.frameA !== sample.frameA)
      fail(`${sample.sampleId}: tree or frame mismatch`);
    const expectedHash = sample.image ? sample.image.sha256 : null;
    const expectedWidth = sample.image ? sample.image.width : null;
    const expectedHeight = sample.image ? sample.image.height : null;
    if (
      label.imageSha256 !== expectedHash ||
      label.width !== expectedWidth ||
      label.height !== expectedHeight
    ) {
      fail(`${sample.sampleId}: label image identity mismatch`);
    }
    for (const key of ['targetVisible', 'personVisible', 'headVisible', 'scalpVisible'])
      nullableBoolean(label[key], `${sample.sampleId}.${key}`);
    const target = point(label.trunkCenter, `${sample.sampleId}.trunkCenter`, true);
    if (target && label.targetVisible !== true)
      fail(`${sample.sampleId}: point requires a visible target`);
    if (label.scalpVisible === true && label.personVisible === false)
      fail(`${sample.sampleId}: scalp/person labels conflict`);
    if (label.headVisible === true && label.personVisible === false)
      fail(`${sample.sampleId}: head/person labels conflict`);
    if (label.scalpVisible === true && label.headVisible === false)
      fail(`${sample.sampleId}: scalp/head labels conflict`);
    const reviewed = isReviewed(label);
    if (reviewed && !sample.image) fail(`${sample.sampleId}: cannot review an absent image`);
    if (isPrimaryReviewed(label)) {
      nonempty(label.reviewer, `${sample.sampleId}.reviewer`);
      if (!['blind', 'prediction_visible'].includes(label.reviewMethod))
        fail(`${sample.sampleId}: review method required`);
      if (label.reviewMethod === 'blind' && sample.image.kind !== 'clean')
        fail(`${sample.sampleId}: marked image cannot be a blind reference`);
      if (label.reviewMethod === 'blind') counts.blind++;
      else counts.predictionVisible++;
    }
    if (reviewed) counts.labeled++;
    else counts.noLabel++;
    let verifiedEvidence = null;
    if (sample.dualEvidence && sample.dualEvidence.state === 'available') {
      verifiedEvidence = validateStoredEvidence(sample.dualEvidence, sample, predictionBase);
      dual.evidenceAvailable++;
    } else if (sample.dual.state === 'success') dual.evidenceUnavailable++;
    if (sample.dualEvidence && !['available', 'unavailable'].includes(sample.dualEvidence.state)) {
      fail(`${sample.sampleId}: invalid pair evidence state`);
    }
    const pair = validatePair(label.pair, sample, verifiedEvidence, `${sample.sampleId}.pair`);
    if (sample.dual.state === 'success') {
      if (!pair) dual.missingPairReview++;
      else {
        if (pair.sameTree !== null) {
          dual.reviewedSame++;
          if (pair.sameTree) dual.confirmedSame++;
          else dual.confirmedDifferent++;
        }
        if (pair.bothAreTarget !== null) {
          dual.reviewedTarget++;
          if (pair.bothAreTarget) dual.confirmedTarget++;
          else dual.confirmedNotTarget++;
        }
      }
    }
    if (label.targetVisible === true) counts.targetVisible++;
    else if (label.targetVisible === false) counts.targetNotVisible++;
    else counts.targetUnknown++;
    let errorPx = null;
    if (label.targetVisible === true && !target) counts.missingReferencePoint++;
    if (target && !predicted) counts.missingPredictionPoint++;
    if (target && predicted) {
      errorPx = Math.hypot(
        (predicted.x - target.x) * sample.image.width,
        (predicted.y - target.y) * sample.image.height,
      );
      if (!Number.isFinite(errorPx)) fail(`${sample.sampleId}: computed pixel error is not finite`);
      errors.all.push(errorPx);
      errors[label.reviewMethod].push(errorPx);
      if (label.reviewMethod === 'blind' && sample.markSource === 'automatic') {
        errors.blindAutomatic.push(errorPx);
        if (sample.dual.state === 'success') errors.blindDualSuccess.push(errorPx);
      }
      if (sample.markSource === 'automatic' || sample.markSource === 'manual')
        errors[sample.markSource].push(errorPx);
      if (sample.dual.state === 'success') errors.dualSuccess.push(errorPx);
      if (sample.dual.state === 'fallback') errors.dualFallback.push(errorPx);
    }
    updateRisk(person, label.personVisible, sample.peoplePrediction.person);
    updateRisk(head, label.headVisible, sample.peoplePrediction.head);
    updateRisk(scalp, label.scalpVisible, sample.peoplePrediction.scalp);
    if (label.reviewMethod === 'blind') {
      updateRisk(personBlind, label.personVisible, sample.peoplePrediction.person);
      updateRisk(headBlind, label.headVisible, sample.peoplePrediction.head);
      updateRisk(scalpBlind, label.scalpVisible, sample.peoplePrediction.scalp);
    }
    details.push({
      sampleId: sample.sampleId,
      errorPx,
      reviewed,
      reviewMethod: label.reviewMethod,
      targetVisible: label.targetVisible,
      dualState: sample.dual.state,
    });
  }
  if (labelsById.size) fail(`Labels without predictions: ${[...labelsById.keys()].join(', ')}`);
  return {
    schema: 'treeextract.evaluation.v1',
    dataset: predictions.dataset,
    counts,
    pointError: Object.fromEntries(
      Object.entries(errors).map(([key, value]) => [key, summarizeErrors(value)]),
    ),
    dual: {
      ...dual,
      unreviewedSame: dual.success - dual.reviewedSame,
      unreviewedTarget: dual.success - dual.reviewedTarget,
      successRateAmongAttempts: rate(dual.success, dual.success + dual.fallback),
      sameTreeRateAmongReviewedSuccesses: rate(dual.confirmedSame, dual.reviewedSame),
      targetRateAmongReviewedSuccesses: rate(dual.confirmedTarget, dual.reviewedTarget),
    },
    person: finishRisk(person),
    head: finishRisk(head),
    scalp: finishRisk(scalp),
    personBlind: finishRisk(personBlind),
    headBlind: finishRisk(headBlind),
    scalpBlind: finishRisk(scalpBlind),
    detectionStatus,
    details,
  };
}

module.exports = {
  PREDICTION_SCHEMA,
  LABEL_SCHEMA,
  MAX_IMAGE_BYTES,
  sha256,
  jpegDimensions,
  verifyImage,
  emptyLabel,
  evaluate,
};
