'use strict';

// Read-only browser smoke for a generated blind-label collection; no labels
// are created or inferred. A missing image is a failure, not a skipped row.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../desktop-js/node_modules/playwright');

async function main() {
  if (process.argv.length !== 3) throw new Error('Expected the collection directory path');
  const collection = path.resolve(process.argv[2]);
  const template = path.join(collection, 'labels', 'labels-template.json');
  const clean = path.join(collection, 'labels', 'clean');
  const document = JSON.parse(fs.readFileSync(template, 'utf8'));
  if (!Array.isArray(document.labels) || !document.labels.length) throw new Error('No samples');
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = [process.env.TREEEXTRACT_BROWSER];
  for (const root of roots) {
    candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  const executablePath = candidates.find((file) => file && fs.existsSync(file));
  if (!executablePath) throw new Error('Local Chrome or Edge is required; test was not run');
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const network = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) network.push(request.url());
  });
  try {
    await page.goto(pathToFileURL(path.join(__dirname, 'annotation', 'index.html')).href);
    await page.locator('#labels-file').setInputFiles(template);
    await page.locator('#photos-dir').setInputFiles(clean);
    for (let i = 0; i < document.labels.length; i++) {
      const label = document.labels[i];
      await page.waitForFunction(
        ({ sample, missing }) =>
          document.querySelector('#identity').textContent.includes(sample) &&
          document
            .querySelector('#status')
            .textContent.includes(missing ? '当前没有可用照片' : '尺寸一致'),
        { sample: label.sampleId, missing: label.imageSha256 === null },
        { timeout: 15000 },
      );
      if (label.imageSha256 !== null) assert.equal(await page.locator('#photo').isVisible(), true);
      if (i + 1 < document.labels.length) await page.locator('#next').click();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    console.log(`BLIND LABEL UI PASS: ${document.labels.length} samples, no annotations created`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
