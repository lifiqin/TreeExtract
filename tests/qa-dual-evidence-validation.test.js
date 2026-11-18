'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decodeAnalysisPng } = require('./qa-png-evidence');
const { validateDualEvidence } = require('./qa-dual-evidence-validation');

const clean = fs.readFileSync(path.join(__dirname, 'fixtures', 'qa-rgba-2x2.png'));
const marked = fs.readFileSync(path.join(__dirname, 'fixtures', 'qa-rgba-marked-2x2.png'));
const url = (bytes) => 'data:image/png;base64,' + bytes.toString('base64');

function fixtures() {
  const hash = decodeAnalysisPng(clean).pixelSha256;
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
    analysisPixelSha256: hash,
  });
  return [
    {
      state: 'available',
      reason: 'success_pair_observations_not_identity',
      treeId: 210,
      treeIndex: 210,
      frameA: 'a.jpg',
      frameB: 'b.jpg',
      attempt: 3,
      hashFormat: 'sha256-wh32le-topdown-bgra32-v1',
      observationA: observation('a.jpg'),
      observationB: observation('b.jpg'),
      panoA: url(clean),
      panoAMarked: url(marked),
      panoB: url(clean),
      panoBMarked: url(marked),
    },
    {
      treeId: 210,
      treeIndex: 210,
      frame: 'a.jpg',
      dualFrameInfo: { state: 'success', frameA: 'a.jpg', frameB: 'b.jpg', attempts: 3 },
    },
  ];
}

test('available evidence is bound to the successful pair and independent PNG pixel hashes', () => {
  const [evidence, snapshot] = fixtures();
  const result = validateDualEvidence(evidence, snapshot);
  assert.equal(result.state, 'available');
  assert.equal(result.observationA.analysisPixelSha256, decodeAnalysisPng(clean).pixelSha256);
  assert.equal(result.images.panoB.width, 2);
  assert.notEqual(result.images.panoB.pixelSha256, result.images.panoBMarked.pixelSha256);
});

test('mismatched pair identity, attempt, frame or source pixels fail closed', () => {
  const [evidence, snapshot] = fixtures();
  assert.throws(
    () => validateDualEvidence({ ...evidence, treeId: 211 }, snapshot),
    /current successful pair/,
  );
  assert.throws(
    () => validateDualEvidence({ ...evidence, attempt: 2 }, snapshot),
    /current successful pair/,
  );
  assert.throws(
    () => validateDualEvidence({ ...evidence, frameB: 'c.jpg' }, snapshot),
    /current successful pair/,
  );
  assert.throws(
    () =>
      validateDualEvidence(
        {
          ...evidence,
          observationB: { ...evidence.observationB, analysisPixelSha256: '0'.repeat(64) },
        },
        snapshot,
      ),
    /pixel SHA-256 mismatch/,
  );
  assert.throws(
    () => validateDualEvidence({ ...evidence, panoAMarked: evidence.panoA }, snapshot),
    /missing marker/,
  );
  assert.throws(
    () =>
      validateDualEvidence(
        { ...evidence, observationA: { ...evidence.observationA, yTop: 0.9, yBottom: 0.1 } },
        snapshot,
      ),
    /candidate geometry/,
  );
  assert.throws(
    () =>
      validateDualEvidence(evidence, {
        ...snapshot,
        dualFrameInfo: { ...snapshot.dualFrameInfo, state: 'fallback' },
      }),
    /current successful pair/,
  );
});

test('unavailable evidence must not retain stale frames, observations or images', () => {
  const unavailable = {
    state: 'unavailable',
    reason: 'not_success',
    treeId: null,
    treeIndex: null,
    frameA: null,
    frameB: null,
    attempt: null,
    hashFormat: null,
    observationA: null,
    observationB: null,
    panoA: null,
    panoAMarked: null,
    panoB: null,
    panoBMarked: null,
  };
  assert.deepEqual(validateDualEvidence(unavailable, null), {
    state: 'unavailable',
    reason: 'not_success',
  });
  assert.throws(
    () => validateDualEvidence({ ...unavailable, frameB: 'old.jpg' }, null),
    /stale frameB/,
  );
  assert.throws(
    () => validateDualEvidence({ ...unavailable, panoB: url(clean) }, null),
    /stale panoB/,
  );
});

test('a changed pixel far from the selected candidate is not accepted as its marker', () => {
  const [evidence, snapshot] = fixtures();
  const blank = fs.readFileSync(path.join(__dirname, 'fixtures', 'qa-rgba-100x50.png'));
  const far = fs.readFileSync(path.join(__dirname, 'fixtures', 'qa-rgba-far-100x50.png'));
  const hash = decodeAnalysisPng(blank).pixelSha256;
  evidence.observationA = {
    ...evidence.observationA,
    width: 100,
    height: 50,
    x: 0.2,
    yTop: 0.1,
    yBottom: 0.3,
    analysisPixelSha256: hash,
  };
  evidence.panoA = url(blank);
  evidence.panoAMarked = url(far);
  assert.throws(() => validateDualEvidence(evidence, snapshot), /no marked pixel near/);
});
