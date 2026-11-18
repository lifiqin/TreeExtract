'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../desktop-js/node_modules/playwright');
const { sha256, emptyLabel, LABEL_SCHEMA } = require('./qa-annotations');

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

test(
  'offline browser validates local images, preserves unknowns, and exports labels only',
  { timeout: 60000 },
  async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-annotation-ui-'));
    const clean = path.join(work, 'clean');
    fs.mkdirSync(clean);
    const imagePath = path.join(clean, '000120-clean.jpg');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'qa-blank-120x90.jpg'), imagePath);
    const image = fs.readFileSync(imagePath);
    const label = emptyLabel({
      sampleId: 'D1:120',
      treeId: 120,
      frameA: 'a.jpg',
      image: { sha256: sha256(image), width: 120, height: 90 },
    });
    const labelPath = path.join(work, 'labels.json');
    fs.writeFileSync(
      labelPath,
      JSON.stringify({ schema: LABEL_SCHEMA, dataset: 'D1', labels: [label] }),
    );
    const predictionsPath = path.join(work, 'predictions.json');
    fs.writeFileSync(
      predictionsPath,
      JSON.stringify({ schema: 'treeextract.predictions.v1', samples: [] }),
    );

    const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    const networkRequests = [];
    page.on('dialog', (dialog) => dialog.accept());
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) networkRequests.push(request.url());
    });
    try {
      await page.goto(pathToFileURL(path.join(__dirname, 'annotation', 'index.html')).href);
      await page.locator('#labels-file').setInputFiles(labelPath);
      await page.locator('#photos-dir').setInputFiles(clean);
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('尺寸一致'),
      );
      assert.equal(await page.locator('#sample-title').innerText(), '第 1 / 1 张 · 树号 120');
      await page.locator('#reviewer').fill('reviewer-test');
      await page.locator('#photo').click();
      assert.match(
        await page.locator('#coordinates').innerText(),
        /x=0\.[45]\d{3}，y=0\.[45]\d{3}/,
      );
      assert.equal(await page.locator('#point-layer').isVisible(), true);
      assert.match(await page.locator('#point').getAttribute('cx'), /%$/);
      await page.locator('#person').selectOption('yes');
      await page.locator('#head').selectOption('yes');
      await page.locator('#person').selectOption('no');
      assert.match(await page.locator('#status').innerText(), /矛盾/);
      assert.equal(await page.locator('#person').inputValue(), 'yes');
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#export').click();
      const download = await downloadPromise;
      const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      assert.equal(exported.labels[0].reviewMethod, 'blind');
      assert.equal(exported.labels[0].reviewer, 'reviewer-test');
      assert.equal(exported.labels[0].scalpVisible, null);
      assert.equal(exported.labels[0].treeId, label.treeId);
      assert.equal(exported.labels[0].imageSha256, label.imageSha256);
      assert.ok(Math.abs(exported.labels[0].trunkCenter.x - 0.5) < 0.01);
      assert.ok(Math.abs(exported.labels[0].trunkCenter.y - 0.5) < 0.01);

      fs.copyFileSync(path.join(__dirname, 'fixtures', 'qa-blank-100x50.jpg'), imagePath);
      await page.locator('#photos-dir').setInputFiles(clean);
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('尺寸'),
      );
      assert.equal(await page.locator('#photo').isVisible(), false);
      await page.locator('#export').click();
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('未导出'),
      );
      fs.copyFileSync(path.join(__dirname, 'fixtures', 'qa-blue-120x90.jpg'), imagePath);
      await page.locator('#photos-dir').setInputFiles(clean);
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('SHA-256 与'),
      );
      assert.match(await page.locator('#status').innerText(), /不一致/);
      assert.equal(await page.locator('#photo').isVisible(), false);
      await page.locator('#labels-file').setInputFiles(predictionsPath);
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('模板'),
      );
      assert.equal(await page.locator('#export').isEnabled(), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(networkRequests, []);
    } finally {
      await context.close();
      await browser.close();
    }
  },
);
