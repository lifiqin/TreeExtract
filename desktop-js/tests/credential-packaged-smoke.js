'use strict';

// 在两个真实打包形态之间验证 Windows 安全存储；仅使用占位密钥，不调用网络。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { assertIsolatedUnpackedExecutable } = require('./packaged-test-safety');

const desktop = path.resolve(__dirname, '..');
const source = path.resolve(desktop, '..', '..', 'tree');
const portable = process.env.TREEEXTRACT_PORTABLE_EXE;
const fast = process.env.TREEEXTRACT_FAST_EXE;
if (!portable || !fast) throw new Error('Set TREEEXTRACT_PORTABLE_EXE and TREEEXTRACT_FAST_EXE.');
if (!assertIsolatedUnpackedExecutable(fast))
  throw new Error('TREEEXTRACT_FAST_EXE must point to an isolated unpacked application.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-credential-portable-'));
const data = path.join(temporary, 'data');
const userData = path.join(temporary, 'user-data');
fs.mkdirSync(data);
fs.mkdirSync(userData);
for (const name of [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
])
  fs.copyFileSync(path.join(source, name), path.join(data, name));

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return result;
}

async function useApp(executable, kind, action) {
  const port = await freePort();
  const extraction = path.join(temporary, `extract-${kind}`);
  fs.mkdirSync(extraction);
  const env = {
    ...process.env,
    TEMP: extraction,
    TMP: extraction,
    TREEEXTRACT_DATA_DIR: data,
    TREEEXTRACT_ZIP: path.join(source, 'Camera4.zip'),
    TREEEXTRACT_TEST_HIDDEN: '1',
    TREEEXTRACT_TEST_USER_DATA: userData,
  };
  delete env.DEEPSEEK_API_KEY;
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env,
    windowsHide: true,
    stdio: 'ignore',
  });
  let browser;
  try {
    const deadline = Date.now() + 120000;
    while (!browser && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Packaged app exited early.');
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!browser) throw new Error('Packaged app startup timed out.');
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 30000 }));
    await page.waitForFunction(
      () =>
        document.querySelector('#summary-trees')?.textContent === '228' &&
        !document.querySelector('#recognize').disabled,
      null,
      { timeout: 90000 },
    );
    await action(page);
    await page.evaluate(() => window.close()).catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null)
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  }
}

async function run() {
  const placeholder = 'packaged-test-placeholder-key';
  await useApp(fast, 'fast', async (page) => {
    assert.equal(
      (await page.evaluate(() => window.treeApp.speciesCredentialStatus())).configured,
      false,
    );
    await page.locator('#species-key').fill(placeholder);
    await page.locator('#species-key-save').click();
    await page.waitForFunction(
      () => document.querySelector('#species-key-status').textContent.includes('加密保存'),
      null,
      { timeout: 30000 },
    );
    assert.equal(await page.locator('#species-key').inputValue(), '');
  });
  const encrypted = fs.readFileSync(path.join(userData, 'cloud-credentials', 'deepseek.dat'));
  assert.equal(encrypted.includes(Buffer.from(placeholder)), false);
  await useApp(portable, 'portable', async (page) => {
    assert.equal(
      (await page.evaluate(() => window.treeApp.speciesCredentialStatus())).configured,
      true,
    );
    assert.equal(await page.locator('#species-key').inputValue(), '');
  });
  console.log(
    'PACKAGED CREDENTIAL PASS: fast to portable, encrypted placeholder, no network request',
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
