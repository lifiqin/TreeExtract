'use strict';

// 独立的模拟后端 UI 检查：不加载现场照片、不启动真实算法进程。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const desktop = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-ui-layout-'));
const main = `
const { app, BrowserWindow, net, protocol } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'treeextract', privileges: { standard: true, secure: true } }]);
app.whenReady().then(() => {
  const root = process.env.TREEEXTRACT_TEST_RENDERER;
  protocol.handle('treeextract', (request) => {
    const url = new URL(request.url);
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    const relative = path.relative(root, file);
    if (url.hostname !== 'app' || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
  const win = new BrowserWindow({
    width: 1540, height: 950, minWidth: 1100, minHeight: 700, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.once('ready-to-show', () => { win.setPosition(-10000, -10000); win.showInactive(); });
  win.loadURL('treeextract://app/index.html');
});
app.on('window-all-closed', () => app.quit());
`;
const preload = `
const { contextBridge } = require('electron');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = { calls: [], inFlight: 0, maxInFlight: 0, images: 0, fullImages: 0, panoImages: 0, lastMark: null, failNext: false };
const current = {
  loaded: true, dataDir: 'test-data', zipPath: 'test.zip', treeCount: 2, treeIndex: 1,
  treeId: 1, treeHeight: 10, frame: 'test.jpg', frameIndex: 1, frameCount: 1,
  framePoseAvailable: true, targetValid: true, cameraHorizontalDistance: 5,
  bearing: 100, distance: 5, elevation: 2, viewPan: 90, viewTilt: 0, viewFov: 90,
  cal: 0, calV: 0, cropWidth: 30, cropHeight: 80, autoFrame: true,
  dualFrame: false, frameStrategy: 'quality', levelView: true, lowDistortion: true,
  lockView: true, markDirty: false, markMode: '自动', status: '测试就绪',
  dualFrameInfo: { state: 'disabled' }, photoRisk: { state: 'unverified', reason: '仅用于测试' }
};
const svg = (w, h, fill, label) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
  '<rect width="100%" height="100%" fill="' + fill + '"/>' +
  '<text x="10%" y="20%" fill="white" font-size="42">' + label + '</text></svg>'
);
const snapshot = () => ({ ...current });
contextBridge.exposeInMainWorld('treeApp', {
  defaults: async () => ({ dataDir: 'test-data', zipPath: 'test.zip' }),
  load: async () => snapshot(), state: async () => snapshot(),
  trees: async () => [{ index: 1, id: 1, species: '测试树', height: 10 }],
  selectTree: async (index) => { await wait(200); current.treeIndex = index; current.treeId = index; return snapshot(); },
  speciesCatalog: async () => [],
  speciesContext: async () => ({ scope: { imageSha256: 'mock', treeId: current.treeId }, record: null }),
  panoramaImage: async () => {
    stats.images += 1; stats.panoImages += 1; await wait(15);
    return { panorama: svg(960, 600, '#254f3d', 'Pan ' + stats.calls.length) };
  },
  images: async () => {
    stats.images += 1; stats.fullImages += 1; await wait(15);
    return { panorama: svg(960, 600, '#254f3d', 'Pan ' + stats.calls.length),
      photo: svg(1280, 960, '#306e4f', 'Photo'), crop: svg(600, 900, '#365449', 'Crop'),
      heat: svg(600, 900, '#684952', 'Heat') };
  },
  pan: async (x, y, fov) => {
    stats.inFlight += 1; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    stats.calls.push([x, y, fov]); await wait(80);
    if (stats.failNext) { stats.failNext = false; stats.inFlight -= 1; throw new Error('mock pan failure'); }
    current.viewPan += x; current.viewTilt += y; current.viewFov = fov; current.lockView = false;
    stats.inFlight -= 1; return snapshot();
  },
  setMark: async (x, y) => { stats.lastMark = [x, y]; current.markDirty = true; return snapshot(); },
  setPanoMark: async (x, y) => { stats.lastMark = [x, y]; current.markDirty = true; return snapshot(); },
  failNextPan: () => { stats.failNext = true; },
  metrics: () => ({ ...stats, calls: stats.calls.slice() })
});
`;
fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ main: 'main.js' }));
fs.writeFileSync(path.join(temporary, 'main.js'), main);
fs.writeFileSync(path.join(temporary, 'preload.js'), preload);

async function run() {
  const application = await electron.launch({
    executablePath: require('electron'),
    args: [temporary],
    env: { ...process.env, TREEEXTRACT_TEST_RENDERER: path.join(desktop, 'src', 'renderer') },
    timeout: 30000,
  });
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#pano-image').naturalWidth === 960);
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);

    assert.match(await page.locator('.tree-row').first().innerText(), /# 1/);
    assert.match(await page.locator('.tree-row').first().innerText(), /10\.0 m/);
    assert.doesNotMatch(await page.locator('.tree-row').first().innerText(), /测试树/);
    await page.locator('#tree-search').fill('测试树');
    assert.equal(await page.locator('.tree-row').count(), 0, '不应按原始树种搜索');
    await page.locator('#tree-search').fill('1');
    assert.equal(await page.locator('.tree-row').count(), 1, '应继续支持按树 ID 搜索');
    await page.locator('#tree-search').fill('');
    await page.evaluate(() => {
      window.__treeRowBeforePan = document.querySelector('.tree-row');
    });

    const initial = await page.locator('#pano-stage').boundingBox();
    assert.ok(initial.width >= 700 && initial.height >= 400, '全景画幅未充分放大');
    const photo = await page.locator('#photo-stage').boundingBox();
    assert.ok(photo.width >= 700 && photo.height >= 500, '矫正照片未充分放大');
    const crop = await page.locator('.crop-stage').boundingBox();
    const heat = await page.locator('.heat-stage').boundingBox();
    assert.ok(crop.height >= 340 && heat.height >= 260, '切图或热力图未充分放大');
    await page.screenshot({ path: path.join(temporary, 'desktop.png') });

    const focusPano = page.locator('[data-focus-target="pano-card"]');
    await focusPano.click();
    assert.equal(await focusPano.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#pano-card').getAttribute('role'), 'dialog');
    const focused = await page.locator('#pano-stage').boundingBox();
    assert.ok(focused.width > initial.width * 1.4, '放大模式没有扩展全景区域');
    await page.screenshot({ path: path.join(temporary, 'panorama-focus.png') });

    // 鼠标仍按下时就必须开始真实后端渲染；高频事件不能排队成大量请求。
    const x = focused.x + focused.width / 2;
    const y = focused.y + focused.height / 2;
    const beforeDrag = await page.evaluate(() => window.treeApp.metrics());
    await page.mouse.move(x, y);
    await page.mouse.wheel(100, 0);
    await page.waitForTimeout(180);
    assert.equal(
      (await page.evaluate(() => window.treeApp.state())).viewFov,
      90,
      '水平滚轮不能改变视场',
    );
    await page.mouse.down();
    await page.mouse.move(x + 35, y + 5, { steps: 12 });
    await page.waitForFunction(() => window.treeApp.metrics().calls.length > 0);
    assert.equal(await page.locator('#pano-image').evaluate((image) => image.style.transform), '');
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await page.mouse.move(x + 120, y + 20, { steps: 30 });
    assert.equal(
      (await page.evaluate(() => window.treeApp.metrics())).fullImages,
      beforeDrag.fullImages,
      '拖动中不应反复编码所有图片',
    );
    await page.mouse.up();
    assert.equal(await page.locator('#next-tree').isDisabled(), true);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
    const metrics = await page.evaluate(() => window.treeApp.metrics());
    assert.equal(metrics.maxInFlight, 1);
    assert.ok(metrics.panoImages > 0, '拖动未使用专用全景图请求');
    assert.ok(metrics.fullImages <= beforeDrag.fullImages + 1, '缩放提交前不应反复编码所有图片');
    assert.ok(metrics.calls.length < 20, '拖动请求没有合并');
    const totalPan = metrics.calls.reduce((sum, call) => sum + call[0], 0);
    const totalTilt = metrics.calls.reduce((sum, call) => sum + call[1], 0);
    const shownWidth = Math.min(focused.width, (focused.height * 960) / 600);
    const shownHeight = (shownWidth * 600) / 960;
    assert.ok(Math.abs(totalPan - (-120 * 90) / shownWidth) < 0.01);
    assert.ok(Math.abs(totalTilt - (20 * 90 * 0.625) / shownHeight) < 0.01);
    assert.equal(await page.locator('#pano-image').evaluate((image) => image.style.transform), '');
    await page.waitForFunction(async () => (await window.treeApp.state()).viewFov === 66, null, {
      timeout: 5000,
    });
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
    assert.equal(
      await page.evaluate(() => window.__treeRowBeforePan === document.querySelector('.tree-row')),
      true,
      '同一树的视角变化不应反复重建列表 DOM',
    );

    // 缩放延迟提交时立刻拖动，缩放不能因为拖动占用后台而丢失。
    await page.mouse.wheel(0, -100);
    await page.mouse.down();
    await page.mouse.move(x + 160, y + 20, { steps: 5 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForFunction(async () => (await window.treeApp.state()).viewFov === 58, null, {
      timeout: 5000,
    });
    await page.waitForFunction(
      () =>
        !document.querySelector('#next-tree').disabled &&
        document.querySelector('#option-viewFov').value === '58',
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() => window.treeApp.failNextPan());
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 35, y, { steps: 2 });
    await page.mouse.wheel(0, -100);
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
    await page.waitForTimeout(250);
    assert.equal(
      (await page.evaluate(() => window.treeApp.state())).viewFov,
      58,
      '拖动失败时不能提交遗留缩放',
    );
    await page.mouse.wheel(0, -100);
    await page.evaluate(() => document.querySelector('#next-tree').click());
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
    await page.waitForTimeout(300);
    assert.equal(
      (await page.evaluate(() => window.treeApp.state())).viewFov,
      58,
      '同名帧切树后不能提交旧缩放',
    );
    await page.keyboard.press('Escape');
    assert.equal(await focusPano.getAttribute('aria-expanded'), 'false');

    const focusPhoto = page.locator('[data-focus-target="photo-card"]');
    await focusPhoto.click();
    assert.equal(await page.locator('#edit-mark').getAttribute('aria-pressed'), 'false');
    await page.locator('#edit-mark').click();
    assert.equal(await page.locator('#edit-mark').getAttribute('aria-pressed'), 'true');
    await page.locator('#photo-image').click();
    try {
      await page.waitForFunction(() => window.treeApp.metrics().lastMark !== null, null, {
        timeout: 5000,
      });
    } catch (error) {
      await page.screenshot({ path: path.join(temporary, 'failed-mark.png') });
      console.error('Evidence: ' + temporary);
      console.error(
        await page.evaluate(() => ({
          pressed: document.querySelector('#edit-mark').getAttribute('aria-pressed'),
          disabled: document.querySelector('#next-tree').disabled,
          status: document.querySelector('#status-text').textContent,
          naturalWidth: document.querySelector('#photo-image').naturalWidth,
          metrics: window.treeApp.metrics(),
        })),
      );
      throw error;
    }
    const mark = (await page.evaluate(() => window.treeApp.metrics())).lastMark;
    assert.ok(Math.abs(mark[0] - 0.5) < 0.01 && Math.abs(mark[1] - 0.5) < 0.01);
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
    await page.keyboard.press('Escape');

    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1100, 700),
    );
    await page.waitForTimeout(200);
    const layout = await page.locator('.workspace').evaluate((node) => ({
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      height: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    assert.ok(layout.scrollWidth <= layout.width + 1, '小窗口出现横向截断');
    assert.ok(layout.scrollHeight > layout.height, '小窗口应可纵向滚动查看大图');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(temporary, 'compact.png') });
    console.log('UI LAYOUT PASS; mock data only; screenshots: ' + temporary);
  } finally {
    await application.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
