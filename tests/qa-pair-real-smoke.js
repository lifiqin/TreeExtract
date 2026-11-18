'use strict';

// Read-only UI smoke on a real collection. It does not create review labels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../desktop-js/node_modules/playwright');

async function main() {
  if (process.argv.length !== 3) throw new Error('Expected the collection directory path');
  const collection = path.resolve(process.argv[2]);
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
  const errors = [],
    network = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) network.push(request.url());
  });
  try {
    await page.goto(pathToFileURL(path.join(__dirname, 'annotation', 'pair.html')).href);
    await page
      .locator('#labels-file')
      .setInputFiles(path.join(collection, 'labels', 'labels-template.json'));
    await page
      .locator('#predictions-file')
      .setInputFiles(path.join(collection, 'evidence', 'predictions.json'));
    await page.locator('#pairs-dir').setInputFiles(path.join(collection, 'evidence', 'pairs'));
    await page.waitForFunction(
      () => document.querySelector('#status').textContent.includes('尺寸一致'),
      null,
      { timeout: 30000 },
    );
    assert.equal(await page.locator('#image-a').isVisible(), true);
    assert.equal(await page.locator('#image-b').isVisible(), true);
    assert.equal(await page.locator('#same-tree').inputValue(), 'unknown');
    assert.equal(await page.locator('#target-tree').inputValue(), 'unknown');
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    console.log(
      'PAIR REVIEW UI PASS: actual verified A/B images displayed; no truth labels created',
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
