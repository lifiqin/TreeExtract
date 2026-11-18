'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { chromium } = require('../desktop-js/node_modules/playwright');
const { sha256, emptyLabel, PREDICTION_SCHEMA, LABEL_SCHEMA } = require('./qa-annotations');
const { decodeAnalysisPng } = require('./qa-png-evidence');
const core = require('./annotation/annotation-core');

function browserPath() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = [process.env.TREEEXTRACT_BROWSER];
  for (const root of roots) {
    candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  const found = candidates.find((file) => file && fs.existsSync(file));
  if (!found) throw new Error('Local Chrome or Edge is required; test was not run.');
  return found;
}

function createEvidence(work) {
  const pairDir = path.join(work, 'pairs');
  fs.mkdirSync(pairDir);
  const clean = fs.readFileSync(path.join(__dirname, 'fixtures', 'qa-rgba-2x2.png'));
  const marked = fs.readFileSync(path.join(__dirname, 'fixtures', 'qa-rgba-marked-2x2.png'));
  const images = {};
  for (const key of ['panoA', 'panoAMarked', 'panoB', 'panoBMarked']) {
    const bytes = key.includes('Marked') ? marked : clean;
    const name = `000120-${key}.png`;
    fs.writeFileSync(path.join(pairDir, name), bytes);
    images[key] = { path: `pairs/${name}`, fileSha256: sha256(bytes), ...decodeAnalysisPng(bytes) };
  }
  const photoPath = path.join(__dirname, 'fixtures', 'qa-blank-120x90.jpg');
  const photo = {
    path: photoPath,
    sha256: sha256(fs.readFileSync(photoPath)),
    width: 120,
    height: 90,
    kind: 'clean',
  };
  const sample = {
    sampleId: 'D1:120',
    treeId: 120,
    treeIndex: 120,
    frameA: 'a.jpg',
    image: photo,
    predictedPoint: { x: 0.6, y: 0.5 },
    markSource: 'automatic',
    dual: { state: 'success', frameB: 'b.jpg' },
    dualDiagnostics: { state: 'success', frameA: 'a.jpg', frameB: 'b.jpg', attempts: 2 },
    peoplePrediction: { person: 'unknown', head: 'unknown', scalp: 'unknown' },
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
    analysisPixelSha256: images.panoA.pixelSha256,
  });
  sample.dualEvidence = {
    state: 'available',
    reason: 'success_pair_observations_not_identity',
    treeId: 120,
    treeIndex: 120,
    frameA: 'a.jpg',
    frameB: 'b.jpg',
    attempt: 2,
    hashFormat: 'sha256-wh32le-topdown-bgra32-v1',
    observationA: observation('a.jpg'),
    observationB: observation('b.jpg'),
    images,
  };
  const label = {
    ...emptyLabel(sample),
    reviewer: 'blind-r1',
    reviewMethod: 'blind',
    targetVisible: true,
    trunkCenter: { x: 0.5, y: 0.5 },
  };
  const predictions = { schema: PREDICTION_SCHEMA, dataset: 'D1', samples: [sample] };
  const labels = { schema: LABEL_SCHEMA, dataset: 'D1', labels: [label] };
  const predictionPath = path.join(work, 'predictions.json'),
    labelPath = path.join(work, 'labels.json');
  fs.writeFileSync(predictionPath, JSON.stringify(predictions));
  fs.writeFileSync(labelPath, JSON.stringify(labels));
  return { pairDir, predictionPath, labelPath, sample, label };
}

test('pair review rejects missing identity, ambiguous candidate and altered proof', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-pair-core-'));
  const { sample, label } = createEvidence(work);
  const evidence = core.validatePairPrediction(sample, label, 'D1');
  assert.throws(
    () => core.validatePairPrediction({ ...sample, frameA: 'wrong.jpg' }, label, 'D1'),
    /不一致/,
  );
  const badObservation = { ...evidence.observationA, x: 2 };
  assert.throws(
    () =>
      core.validatePairPrediction(
        { ...sample, dualEvidence: { ...evidence, observationA: badObservation } },
        label,
        'D1',
      ),
    /超出画幅/,
  );
  const yes = { sameTree: true, bothAreTarget: true, candidateVisible: true };
  assert.throws(
    () => core.applyPairReview(label, 'D1', evidence, { ...yes, candidateVisible: false }, 'r'),
    /可辨认/,
  );
  assert.throws(
    () => core.applyPairReview(label, 'D1', evidence, { ...yes, sameTree: false }, 'r'),
    /必须确认同树/,
  );
  assert.throws(() => core.applyPairReview(label, 'D1', evidence, yes, ''), /复核者/);
  assert.throws(
    () =>
      core.applyPairReview(
        label,
        'D1',
        evidence,
        { ...yes, sameTree: null, bothAreTarget: null },
        'r',
      ),
    /保持未知/,
  );
  const reviewed = core.applyPairReview(label, 'D1', evidence, yes, 'pair-r');
  assert.equal(reviewed.reviewer, 'blind-r1');
  assert.equal(reviewed.reviewMethod, 'blind');
  assert.equal(reviewed.pair.reviewer, 'pair-r');
  assert.throws(
    () => core.validatePairLabel({ ...reviewed, pair: { ...reviewed.pair, attempt: 1 } }, evidence),
    /不一致/,
  );
  assert.throws(
    () => core.applyReview(reviewed, 'D1', { targetVisible: true }, 'blind-r1', 'blind'),
    /看过预测/,
  );
});

test(
  'offline pair review binds both winning candidate images and keeps original blind label',
  { timeout: 60000 },
  async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-pair-ui-'));
    const fixture = createEvidence(work);
    const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const errors = [],
      network = [];
    page.on('dialog', (dialog) => dialog.accept());
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) network.push(request.url());
    });
    try {
      await page.goto(pathToFileURL(path.join(__dirname, 'annotation', 'pair.html')).href);
      await page.locator('#labels-file').setInputFiles(fixture.labelPath);
      await page.locator('#predictions-file').setInputFiles(fixture.predictionPath);
      await page.locator('#pairs-dir').setInputFiles(fixture.pairDir);
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('尺寸一致'),
      );
      assert.equal(await page.locator('#image-a').isVisible(), true);
      assert.equal(await page.locator('#image-b').isVisible(), true);
      await page.locator('#reviewer').fill('pair-r2');
      await page.locator('#same-tree').selectOption('yes');
      await page.locator('#target-tree').selectOption('yes');
      await page.locator('#apply').click();
      assert.match(await page.locator('#status').innerText(), /线框均可辨认/);
      await page.locator('#candidates-visible').check();
      await page.locator('#apply').click();
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#export').click();
      const download = await downloadPromise;
      const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      const label = exported.labels[0];
      assert.equal(label.reviewer, 'blind-r1');
      assert.equal(label.reviewMethod, 'blind');
      assert.deepEqual(label.trunkCenter, { x: 0.5, y: 0.5 });
      assert.equal(label.pair.reviewer, 'pair-r2');
      assert.equal(label.pair.reviewMethod, 'candidate_visible');
      assert.equal(label.pair.sameTree, true);
      assert.equal(
        label.pair.markedASha256,
        fixture.sample.dualEvidence.images.panoAMarked.fileSha256,
      );
      assert.equal(
        label.pair.markedBSha256,
        fixture.sample.dualEvidence.images.panoBMarked.fileSha256,
      );

      const saved = path.join(work, 'labels-with-pairs.json'),
        report = path.join(work, 'evaluation.json');
      fs.writeFileSync(saved, JSON.stringify(exported));
      const evaluation = spawnSync(
        process.execPath,
        [
          path.join(__dirname, 'qa-evaluate-annotations.js'),
          '--predictions',
          fixture.predictionPath,
          '--labels',
          saved,
          '--output',
          report,
          '--min-pairs',
          '1',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(evaluation.status, 0, evaluation.stderr);
      assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).dual.confirmedSame, 1);

      fs.copyFileSync(
        path.join(__dirname, 'fixtures', 'qa-rgba-2x2.png'),
        path.join(fixture.pairDir, '000120-panoBMarked.png'),
      );
      await page.locator('#pairs-dir').setInputFiles(fixture.pairDir);
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('SHA-256 不一致'),
      );
      assert.equal(await page.locator('#image-b').isVisible(), false);
      await page.locator('#export').click();
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('未导出'),
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(network, []);
    } finally {
      await context.close();
      await browser.close();
    }
  },
);
