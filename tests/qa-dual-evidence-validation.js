'use strict';

// Validate only the returned winning observations. Never search for or
// reconstruct a trunk candidate in the evaluator.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { decodeAnalysisPng } = require('./qa-png-evidence');

const FORMAT = 'sha256-wh32le-topdown-bgra32-v1';
const IMAGE_KEYS = ['panoA', 'panoAMarked', 'panoB', 'panoBMarked'];
const IDENTITY_KEYS = [
  'treeId',
  'treeIndex',
  'frameA',
  'frameB',
  'attempt',
  'hashFormat',
  'observationA',
  'observationB',
  ...IMAGE_KEYS,
];

function readPng(value, name) {
  if (typeof value !== 'string' || value.length > 90 * 1024 * 1024) {
    throw new Error(`${name}: PNG data is unavailable or too large`);
  }
  const match =
    typeof value === 'string' && value.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error(`${name}: missing PNG data`);
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) throw new Error(`${name}: invalid base64`);
  return {
    bytes,
    fileSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    ...decodeAnalysisPng(bytes, { includePixels: true }),
  };
}

function hasCandidateLine(clean, marked, observation) {
  const { width, height } = clean;
  const centerX = Math.round(observation.x * width);
  const startY = Math.max(0, Math.min(height - 1, Math.round(observation.yTop * height)));
  const endY = Math.max(0, Math.min(height - 1, Math.round(observation.yBottom * height)));
  for (let step = 0; step <= 8; step++) {
    const centerY = Math.round(startY + ((endY - startY) * step) / 8);
    for (let dy = -2; dy <= 2; dy++) {
      const y = centerY + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const x = (((centerX + dx) % width) + width) % width;
        const offset = (y * width + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          if (clean.pixels[offset + channel] !== marked.pixels[offset + channel]) return true;
        }
      }
    }
  }
  return false;
}

function validateObservation(observation, frame, image, name) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation))
    throw new Error(`${name}: invalid observation`);
  if (
    observation.frame !== frame ||
    observation.width !== image.width ||
    observation.height !== image.height
  ) {
    throw new Error(`${name}: frame or dimensions mismatch`);
  }
  for (const field of [
    'azimuthDeg',
    'elevationTopDeg',
    'elevationBottomDeg',
    'widthDeg',
    'azimuthOriginDeg',
    'verticalCalibrationDeg',
    'x',
    'yTop',
    'yBottom',
  ]) {
    if (!Number.isFinite(observation[field])) throw new Error(`${name}: invalid ${field}`);
  }
  if (
    observation.widthDeg <= 0 ||
    observation.x < 0 ||
    observation.x > 1 ||
    observation.yTop < 0 ||
    observation.yBottom > 1 ||
    observation.yTop > observation.yBottom
  ) {
    throw new Error(`${name}: invalid candidate geometry`);
  }
  if (
    !/^[0-9a-f]{64}$/.test(observation.analysisPixelSha256 || '') ||
    observation.analysisPixelSha256 !== image.pixelSha256
  ) {
    throw new Error(`${name}: analysis pixel SHA-256 mismatch`);
  }
}

function validateDualEvidence(evidence, snapshot) {
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence) ||
    typeof evidence.reason !== 'string' ||
    !evidence.reason
  )
    throw new Error('Invalid evidence response');
  if (evidence.state === 'unavailable') {
    for (const field of IDENTITY_KEYS)
      if (evidence[field] !== null) throw new Error(`Unavailable evidence exposes stale ${field}`);
    return { state: 'unavailable', reason: evidence.reason };
  }
  const dual = snapshot && snapshot.dualFrameInfo;
  if (
    evidence.state !== 'available' ||
    !dual ||
    dual.state !== 'success' ||
    evidence.treeId !== snapshot.treeId ||
    evidence.treeIndex !== snapshot.treeIndex ||
    evidence.frameA !== snapshot.frame ||
    evidence.frameA !== dual.frameA ||
    evidence.frameB !== dual.frameB ||
    !evidence.frameA ||
    !evidence.frameB ||
    evidence.frameA === evidence.frameB ||
    evidence.attempt !== dual.attempts ||
    !Number.isSafeInteger(evidence.attempt) ||
    evidence.attempt <= 0 ||
    evidence.hashFormat !== FORMAT
  ) {
    throw new Error('Evidence does not match the current successful pair');
  }
  const images = Object.fromEntries(IMAGE_KEYS.map((key) => [key, readPng(evidence[key], key)]));
  validateObservation(evidence.observationA, evidence.frameA, images.panoA, 'observationA');
  validateObservation(evidence.observationB, evidence.frameB, images.panoB, 'observationB');
  for (const [clean, marked] of [
    ['panoA', 'panoAMarked'],
    ['panoB', 'panoBMarked'],
  ]) {
    if (
      images[clean].width !== images[marked].width ||
      images[clean].height !== images[marked].height ||
      images[clean].pixelSha256 === images[marked].pixelSha256
    ) {
      throw new Error(`${marked}: missing marker or mismatched dimensions`);
    }
    const observation = clean === 'panoA' ? evidence.observationA : evidence.observationB;
    if (!hasCandidateLine(images[clean], images[marked], observation)) {
      throw new Error(`${marked}: no marked pixel near the selected candidate segment`);
    }
  }
  return {
    state: 'available',
    reason: evidence.reason,
    treeId: evidence.treeId,
    treeIndex: evidence.treeIndex,
    frameA: evidence.frameA,
    frameB: evidence.frameB,
    attempt: evidence.attempt,
    hashFormat: evidence.hashFormat,
    observationA: evidence.observationA,
    observationB: evidence.observationB,
    images,
  };
}

function validateStoredEvidence(stored, sample, baseDirectory) {
  if (!stored || stored.state !== 'available')
    throw new Error('Winning pair evidence is unavailable');
  if (
    !stored.images ||
    typeof stored.images !== 'object' ||
    !sample.dualDiagnostics ||
    sample.dual.state !== sample.dualDiagnostics.state ||
    sample.dual.frameB !== (sample.dualDiagnostics.frameB || null)
  ) {
    throw new Error('Stored pair diagnostics are incomplete or inconsistent');
  }
  const raw = { ...stored };
  for (const key of IMAGE_KEYS) {
    const image = stored.images[key];
    if (
      !image ||
      typeof image.path !== 'string' ||
      !image.path ||
      !/^[0-9a-f]{64}$/.test(image.fileSha256 || '')
    ) {
      throw new Error(`${key}: incomplete stored image metadata`);
    }
    const file = path.resolve(baseDirectory, image.path);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw new Error(`${key}: invalid file or size`);
    const bytes = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== image.fileSha256) {
      throw new Error(`${key}: stored PNG SHA-256 mismatch`);
    }
    raw[key] = 'data:image/png;base64,' + bytes.toString('base64');
  }
  const snapshot = {
    treeId: sample.treeId,
    treeIndex: sample.treeIndex,
    frame: sample.frameA,
    dualFrameInfo: sample.dualDiagnostics,
  };
  const verified = validateDualEvidence(raw, snapshot);
  for (const key of IMAGE_KEYS) {
    const expected = stored.images[key],
      actual = verified.images[key];
    if (
      expected.width !== actual.width ||
      expected.height !== actual.height ||
      expected.pixelSha256 !== actual.pixelSha256
    )
      throw new Error(`${key}: stored pixel identity mismatch`);
  }
  return verified;
}

module.exports = { validateDualEvidence, validateStoredEvidence };
