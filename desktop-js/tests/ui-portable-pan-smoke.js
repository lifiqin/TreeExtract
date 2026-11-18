'use strict';

// 在真正的便携 EXE 中检查拖动；只读原 ZIP，所有可写文件使用临时副本。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');

const desktop = path.resolve(__dirname, '..');
const source = path.resolve(desktop, '..', '..', 'tree');
const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) throw new Error('请传入待测便携 EXE 的完整路径');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-portable-pan-'));
const data = path.join(temporary, 'data');
const extraction = path.join(temporary, 'extraction');
fs.mkdirSync(data);
fs.mkdirSync(extraction);
const inputs = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original = Object.fromEntries(inputs.map((name) => [name, hash(path.join(source, name))]));
for (const name of inputs) fs.copyFileSync(path.join(source, name), path.join(data, name));
const zip = path.join(source, 'Camera4.zip');
const zipBefore = fs.statSync(zip);

async function portNumber() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function connect(port, child) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`便携 EXE 提前退出：${child.exitCode}`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('便携 EXE 启动超时');
}

async function run() {
  const port = await portNumber();
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TEMP: extraction,
      TMP: extraction,
      DOTNET_ROOT: path.join(temporary, 'no-system-dotnet'),
      DOTNET_ROOT_X64: path.join(temporary, 'no-system-dotnet'),
      DOTNET_MULTILEVEL_LOOKUP: '0',
      TREEEXTRACT_TEST_HIDDEN: '1',
      TREEEXTRACT_DATA_DIR: data,
      TREEEXTRACT_ZIP: zip,
    },
  });
  let browser;
  try {
    browser = await connect(port, child);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 30000 }));
    await page.waitForFunction(
      () => document.querySelector('#summary-trees')?.textContent === '228',
      null,
      {
        timeout: 90000,
      },
    );
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
    await page.waitForFunction(() => document.querySelector('#pano-image').naturalWidth > 0);
    await page.locator('[data-focus-target="pano-card"]').click();
    const stage = await page.locator('#pano-stage').boundingBox();
    const before = await page.evaluate(() => ({
      image: document.querySelector('#pano-image').src,
      width: document.querySelector('#pano-image').naturalWidth,
      height: document.querySelector('#pano-image').naturalHeight,
    }));
    const x = stage.x + stage.width / 2;
    const y = stage.y + stage.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const start = Date.now();
    await page.mouse.move(x + 100, y + 10, { steps: 12 });
    await page.waitForFunction(
      (src) => {
        const image = document.querySelector('#pano-image');
        return image.src !== src && image.complete && image.naturalWidth > 0;
      },
      before.image,
      {
        timeout: 30000,
      },
    );
    const firstFrameMs = Date.now() - start;
    await page.mouse.move(x + 150, y + 20, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled, null, {
      timeout: 30000,
    });
    assert.equal(await page.locator('#pano-image').evaluate((node) => node.style.transform), '');
    await page.keyboard.press('Escape');
    assert.equal(
      await page.locator('[data-focus-target="pano-card"]').getAttribute('aria-expanded'),
      'false',
    );
    console.log(
      `PORTABLE PAN PASS; first updated frame decoded: ${firstFrameMs} ms; evidence: ${temporary}`,
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    for (const name of inputs) assert.equal(hash(path.join(source, name)), original[name]);
    const zipAfter = fs.statSync(zip);
    assert.equal(zipAfter.size, zipBefore.size);
    assert.equal(zipAfter.mtimeMs, zipBefore.mtimeMs);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
