'use strict';

// 比较同一版单文件和目录版；仅复制元数据、只读 ZIP，不请求云端。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { assertIsolatedUnpackedExecutable } = require('./packaged-test-safety');

const desktop = path.resolve(__dirname, '..');
const source = path.resolve(desktop, '..', '..', 'tree');
const portable = process.env.TREEEXTRACT_PORTABLE_EXE;
const fast = process.env.TREEEXTRACT_FAST_EXE;
if (!portable || !fast) throw new Error('Set TREEEXTRACT_PORTABLE_EXE and TREEEXTRACT_FAST_EXE.');
if (!assertIsolatedUnpackedExecutable(fast))
  throw new Error('TREEEXTRACT_FAST_EXE must point to an isolated unpacked application.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-launch-profile-'));
const data = path.join(temp, 'data');
fs.mkdirSync(data);
const names = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = Object.fromEntries(names.map((name) => [name, digest(path.join(source, name))]));
for (const name of names) fs.copyFileSync(path.join(source, name), path.join(data, name));
const zip = path.join(source, 'Camera4.zip');
const zipBefore = fs.statSync(zip);

async function port() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return result;
}

async function measure(executable, label, index) {
  const debugPort = await port();
  const runDir = path.join(temp, `${label}-${index}`);
  const extraction = path.join(runDir, 'temp');
  const userData = path.join(runDir, 'user-data');
  fs.mkdirSync(extraction, { recursive: true });
  fs.mkdirSync(userData);
  const env = {
    ...process.env,
    TEMP: extraction,
    TMP: extraction,
    TREEEXTRACT_DATA_DIR: data,
    TREEEXTRACT_ZIP: zip,
    TREEEXTRACT_TEST_HIDDEN: '1',
    TREEEXTRACT_TEST_USER_DATA: userData,
  };
  delete env.DEEPSEEK_API_KEY;
  const start = performance.now();
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    env,
    windowsHide: true,
    stdio: 'ignore',
  });
  let browser;
  try {
    const deadline = Date.now() + 120000;
    while (!browser && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Application exited during benchmark.');
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 500 });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!browser) throw new Error('Timed out starting application.');
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 30000 }));
    await page.waitForFunction(
      () =>
        document.querySelector('#summary-trees')?.textContent === '228' &&
        document.querySelector('#pano-image').naturalWidth > 0 &&
        !document.querySelector('#recognize').disabled,
      null,
      { timeout: 90000 },
    );
    const elapsed = performance.now() - start;
    console.log(`LAUNCH_${label.toUpperCase()}_MS=${Math.round(elapsed)}`);
    await page.evaluate(() => window.close()).catch(() => {});
    return elapsed;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null)
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  }
}

async function run() {
  const results = { portable: [], fast: [] };
  for (const [label, executable] of [
    ['portable', portable],
    ['fast', fast],
    ['fast', fast],
    ['portable', portable],
  ])
    results[label].push(await measure(executable, label, results[label].length));
  for (const name of names)
    if (digest(path.join(source, name)) !== before[name]) throw new Error('Original data changed.');
  const zipAfter = fs.statSync(zip);
  if (zipAfter.size !== zipBefore.size || zipAfter.mtimeMs !== zipBefore.mtimeMs)
    throw new Error('ZIP changed.');
  console.log(`LAUNCH_PROFILE_SUMMARY=${JSON.stringify(results)}`);
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
