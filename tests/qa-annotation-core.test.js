'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sha256, jpegDimensions, emptyLabel, LABEL_SCHEMA } = require('./qa-annotations');
const core = require('./annotation/annotation-core');

const imagePath = path.join(__dirname, 'fixtures', 'qa-blank-120x90.jpg');
const bytes = fs.readFileSync(imagePath);

function fixture() {
  const sample = {
    sampleId: 'D1:120',
    treeId: 120,
    frameA: 'a.jpg',
    image: { sha256: sha256(bytes), width: 120, height: 90 },
  };
  return { schema: LABEL_SCHEMA, dataset: 'D1', labels: [emptyLabel(sample)] };
}

test('offline editor accepts only label schema and preserves unknowns', () => {
  const doc = fixture();
  assert.equal(core.validateDocument(doc), doc);
  assert.equal(core.sampleFileName(doc.labels[0], doc.dataset), '000120-clean.jpg');
  assert.equal(core.hasReview(doc.labels[0]), false);
  assert.throws(() => core.validateDocument({ ...doc, samples: [] }), /模板/);
  assert.throws(
    () => core.validateDocument({ ...doc, labels: [doc.labels[0], doc.labels[0]] }),
    /重复/,
  );
  assert.throws(
    () =>
      core.validateDocument({
        ...doc,
        labels: [{ ...doc.labels[0], predictedPoint: { x: 0, y: 0 } }],
      }),
    /字段|预测/,
  );
});

test('offline editor validates image bytes, SHA-256 and actual dimensions', async () => {
  const doc = fixture();
  const label = doc.labels[0];
  const size = jpegDimensions(bytes);
  assert.equal(await core.verifyImage(bytes, size.width, size.height, label), true);
  await assert.rejects(core.verifyImage(bytes, 90, 120, label), /尺寸/);
  await assert.rejects(
    core.verifyImage(bytes, 120, 90, { ...label, imageSha256: '0'.repeat(64) }),
    /SHA-256/,
  );
  await assert.rejects(core.verifyImage(Buffer.from([1, 2, 3, 4]), 120, 90, label), /JPEG/);
});

test('marking requires an explicit reviewer and cannot alter sample identity', () => {
  const doc = fixture();
  const label = doc.labels[0];
  assert.throws(() => core.applyReview(label, 'D1', { targetVisible: true }, '', 'blind'), /代号/);
  assert.throws(() => core.applyReview(label, 'D1', { treeId: 200 }, 'r1', 'blind'), /身份/);
  assert.throws(
    () =>
      core.applyReview(
        label,
        'D1',
        { targetVisible: false, trunkCenter: { x: 0.5, y: 0.5 } },
        'r1',
        'blind',
      ),
    /可见/,
  );
  const result = core.applyReview(
    label,
    'D1',
    { targetVisible: true, trunkCenter: { x: 0.5, y: 0.4 } },
    'r1',
    'blind',
  );
  assert.equal(result.imageSha256, label.imageSha256);
  assert.equal(result.treeId, label.treeId);
  assert.equal(label.trunkCenter, null);
  assert.deepEqual(result.trunkCenter, { x: 0.5, y: 0.4 });
});

test('contradictory head/person/scalp labels and clicks outside the image fail closed', () => {
  const doc = fixture();
  const label = core.applyReview(
    doc.labels[0],
    'D1',
    { personVisible: true, headVisible: true },
    'r1',
    'blind',
  );
  assert.throws(
    () => core.applyReview(label, 'D1', { personVisible: false }, 'r1', 'blind'),
    /矛盾/,
  );
  assert.throws(
    () => core.applyReview(label, 'D1', { headVisible: false, scalpVisible: true }, 'r1', 'blind'),
    /矛盾/,
  );
  assert.deepEqual(core.normalizedPoint(60, 65, { left: 10, top: 20, width: 100, height: 90 }), {
    x: 0.5,
    y: 0.5,
  });
  assert.throws(
    () => core.normalizedPoint(-5, 0, { left: 0, top: 0, width: 100, height: 90 }),
    /范围/,
  );
});
