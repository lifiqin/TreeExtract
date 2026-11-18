'use strict';

// 本机性能采样：复制元数据与运行时，只读原 ZIP；不进行网络请求。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { copyRuntime } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const source = process.env.TREEEXTRACT_UI_TEST_DATA || path.resolve(desktop, '..', '..', 'tree');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-resource-'));
const isolatedDesktop = path.join(temporary, 'desktop');
const isolatedData = path.join(temporary, 'data');
const isolatedUserData = path.join(temporary, 'user-data');
const zip = path.join(source, 'Camera4.zip');
const inputs = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = Object.fromEntries(inputs.map((name) => [name, hash(path.join(source, name))]));
const zipBefore = fs.statSync(zip);
fs.mkdirSync(isolatedDesktop);
fs.mkdirSync(isolatedData);
fs.mkdirSync(isolatedUserData);
fs.cpSync(path.join(desktop, 'src'), path.join(isolatedDesktop, 'src'), { recursive: true });
fs.copyFileSync(path.join(desktop, 'package.json'), path.join(isolatedDesktop, 'package.json'));
copyRuntime(
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe'),
  path.join(isolatedDesktop, 'runtime'),
);
for (const name of inputs) fs.copyFileSync(path.join(source, name), path.join(isolatedData, name));

async function sample(application, label) {
  const metrics = await application.evaluate(({ app }) =>
    app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({ pid, type, cpu, memory })),
  );
  console.log(`PROFILE_${label}=${JSON.stringify(metrics)}`);
  const backend = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'profile-backend.ps1'),
      '-RuntimeDirectory',
      path.join(isolatedDesktop, 'runtime'),
      '-Seconds',
      '4',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  console.log(`PROFILE_BACKEND_${label}=${backend}`);
}

async function run() {
  const env = {
    ...process.env,
    TREEEXTRACT_DATA_DIR: isolatedData,
    TREEEXTRACT_ZIP: zip,
    TREEEXTRACT_TEST_HIDDEN: '1',
    TREEEXTRACT_TEST_USER_DATA: isolatedUserData,
  };
  delete env.DEEPSEEK_API_KEY;
  const started = performance.now();
  const application = await electron.launch({
    executablePath: require('electron'),
    args: [isolatedDesktop],
    cwd: isolatedDesktop,
    env,
    timeout: 60000,
  });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(
      () =>
        document.querySelector('#summary-trees')?.textContent === '228' &&
        document.querySelector('#pano-image').naturalWidth > 0 &&
        !document.querySelector('#recognize').disabled,
      null,
      { timeout: 90000 },
    );
    console.log(`PROFILE_READY_DIR=${temporary}`);
    console.log(`PROFILE_STARTUP_MS=${Math.round(performance.now() - started)}`);
    await page.waitForTimeout(5000);
    await sample(application, 'IDLE_BEFORE_RECOGNITION');
    const classify = performance.now();
    await page.locator('#recognize').click();
    await page.waitForFunction(
      () => document.querySelector('#recognition-result').textContent.includes('候选：'),
      null,
      { timeout: 120000 },
    );
    await page.waitForFunction(() => !document.querySelector('#recognize').disabled, null, {
      timeout: 120000,
    });
    console.log(`PROFILE_RECOGNITION_MS=${Math.round(performance.now() - classify)}`);
    await page.waitForTimeout(5000);
    await sample(application, 'IDLE_AFTER_RECOGNITION');
  } finally {
    await application.evaluate(({ app }) => app.exit()).catch(() => {});
    for (const name of inputs) assertEqual(hash(path.join(source, name)), before[name]);
    const after = fs.statSync(zip);
    assertEqual(after.size, zipBefore.size);
    assertEqual(after.mtimeMs, zipBefore.mtimeMs);
  }
}

function assertEqual(actual, expected) {
  if (actual !== expected) throw new Error('Original input changed during profiling.');
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
