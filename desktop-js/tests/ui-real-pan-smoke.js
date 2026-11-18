'use strict';

// 真实全景拖动烟雾测试：只读原始 ZIP，小数据和运行时均复制到临时目录。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { copyRuntime } = require('./test-runtime');

const desktop = process.env.TREEEXTRACT_UI_TEST_DESKTOP || path.resolve(__dirname, '..');
const source = process.env.TREEEXTRACT_UI_TEST_DATA || path.resolve(desktop, '..', '..', 'tree');
const zip = path.join(source, 'Camera4.zip');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-real-pan-'));
const isolatedDesktop = path.join(temporary, 'desktop');
const isolatedData = path.join(temporary, 'data');
const isolatedUserData = path.join(temporary, 'user-data');
const inputs = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = Object.fromEntries(inputs.map((name) => [name, hash(path.join(source, name))]));
const originalZip = fs.statSync(zip);
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

async function run() {
  const application = await electron.launch({
    executablePath: require('electron'),
    args: [isolatedDesktop],
    cwd: isolatedDesktop,
    env: {
      ...process.env,
      TREEEXTRACT_DATA_DIR: isolatedData,
      TREEEXTRACT_ZIP: zip,
      TREEEXTRACT_TEST_HIDDEN: '1',
      TREEEXTRACT_TEST_USER_DATA: isolatedUserData,
      DOTNET_ROOT: path.join(temporary, 'no-system-dotnet'),
      DOTNET_ROOT_X64: path.join(temporary, 'no-system-dotnet'),
      DOTNET_MULTILEVEL_LOOKUP: '0',
    },
    timeout: 60000,
  });
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(
      () => document.querySelector('#summary-trees').textContent === '228',
      null,
      {
        timeout: 90000,
      },
    );
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled, null, {
      timeout: 90000,
    });
    await page.waitForFunction(() => document.querySelector('#pano-image').naturalWidth > 0);
    await page.screenshot({ path: path.join(temporary, 'real-layout.png') });
    const exportedCrop = path.join(temporary, 'crop.png');
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      // 与产品的新导出保护一致：测试中显式模拟人工确认，而不是绕过后端校验。
      dialog.showMessageBox = async (_window, options) => ({
        response: options.title === '保存前人工核查' ? 1 : 0,
      });
    }, exportedCrop);
    await page.locator('#save-crop').click();
    await page.waitForFunction(
      (target) => document.querySelector('#status-text').textContent.includes(target),
      exportedCrop,
      { timeout: 15000 },
    );
    assert.ok(fs.statSync(exportedCrop).size > 1000, '切图保存失败');
    // 在同一视角交替测试两种分辨率，包含 IPC、编码和浏览器解码；
    // 只记录本机耗时，不把单机数据当成所有设备的帧率保证。
    const timings = await page.evaluate(async () => {
      const samples = { preview: [], full: [] };
      const dimensions = {};
      for (let index = 0; index < 10; index += 1) {
        const order = index % 2 ? [false, true] : [true, false];
        for (const preview of order) {
          const start = performance.now();
          const frame = await window.treeApp.panoramaImage(preview);
          const image = new Image();
          image.src = frame.panorama;
          await image.decode();
          const label = preview ? 'preview' : 'full';
          dimensions[label] = [image.naturalWidth, image.naturalHeight];
          if (index >= 2) samples[label].push(performance.now() - start);
        }
      }
      for (const values of Object.values(samples)) values.sort((a, b) => a - b);
      return { dimensions, previewMs: samples.preview[4], fullMs: samples.full[4] };
    });
    assert.deepEqual(timings.dimensions.preview, [640, 400]);
    assert.deepEqual(timings.dimensions.full, [960, 600]);
    const before = await page.evaluate(() => window.treeApp.state());
    await page.locator('[data-focus-target="pano-card"]').click();
    const stage = await page.locator('#pano-stage').boundingBox();
    const image = await page.locator('#pano-image').evaluate((node) => ({
      src: node.src,
      width: node.naturalWidth,
      height: node.naturalHeight,
    }));
    const width = Math.min(stage.width, (stage.height * image.width) / image.height);
    const height = (width * image.height) / image.width;
    const x = stage.x + stage.width / 2;
    const y = stage.y + stage.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const started = Date.now();
    await page.mouse.move(x + 90, y + 10, { steps: 12 });
    await page.waitForFunction(
      (old) => {
        const image = document.querySelector('#pano-image');
        return image.src !== old && image.complete && image.naturalWidth > 0;
      },
      image.src,
      {
        timeout: 30000,
      },
    );
    const firstFrameMs = Date.now() - started;
    assert.equal(await page.locator('#pano-image').evaluate((node) => node.style.transform), '');
    await page.mouse.move(x + 150, y + 20, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled, null, {
      timeout: 30000,
    });
    await page.waitForFunction(
      () =>
        document.querySelector('#pano-image').naturalWidth === 960 &&
        document.querySelector('#pano-image').complete,
      null,
      { timeout: 30000 },
    );
    const after = await page.evaluate(() => window.treeApp.state());
    const expectedPan = (((before.viewPan - (150 * before.viewFov) / width) % 360) + 360) % 360;
    const expectedTilt = Math.max(
      -89,
      Math.min(89, before.viewTilt + (20 * before.viewFov * 0.625) / height),
    );
    assert.ok(Math.abs(after.viewPan - expectedPan) < 0.03, '拖动最终方位与位移不一致');
    assert.ok(Math.abs(after.viewTilt - expectedTilt) < 0.03, '拖动最终俯仰与位移不一致');
    assert.equal(after.lockView, false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(temporary, 'real-pan-focus.png') });
    console.log(
      `REAL PAN PASS; first updated frame: ${firstFrameMs} ms; median preview/full: ${timings.previewMs.toFixed(1)}/${timings.fullMs.toFixed(1)} ms; evidence: ${temporary}`,
    );
  } finally {
    await application.evaluate(({ app }) => app.exit()).catch(() => {});
    for (const name of inputs) assert.equal(hash(path.join(source, name)), hashes[name]);
    const afterZip = fs.statSync(zip);
    assert.equal(afterZip.size, originalZip.size);
    assert.equal(afterZip.mtimeMs, originalZip.mtimeMs);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
