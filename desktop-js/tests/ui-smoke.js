'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { copyRuntime } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const project = path.resolve(desktop, '..');
const sourceData = path.resolve(project, '..', 'tree');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-ui-'));
const isolatedUserData = path.join(temp, 'user-data');
fs.mkdirSync(isolatedUserData);
const isolatedDesktop = path.join(temp, 'desktop-app');
fs.mkdirSync(isolatedDesktop);
fs.cpSync(path.join(desktop, 'src'), path.join(isolatedDesktop, 'src'), { recursive: true });
fs.copyFileSync(path.join(desktop, 'package.json'), path.join(isolatedDesktop, 'package.json'));
copyRuntime(
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe'),
  path.join(isolatedDesktop, 'runtime'),
);
const files = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
for (const name of files) fs.copyFileSync(path.join(sourceData, name), path.join(temp, name));
const originalMarks = hash(path.join(sourceData, 'manual_marks.csv'));
const originalTrees = hash(path.join(sourceData, 'tree_centers2.txt'));
const artifacts = path.join(desktop, 'test-artifacts');
fs.mkdirSync(artifacts, { recursive: true });

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 独立从测试数据计算当前树到当前帧的水平距离，确保切换后没有沿用旧值。
function assertHorizontalDistance(state, directory) {
  const pose = fs
    .readFileSync(path.join(directory, 'Metashape.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns[0] === state.frame);
  if (!pose || !Number.isFinite(Number(pose[1])) || !Number.isFinite(Number(pose[2]))) {
    assert.equal(state.cameraHorizontalDistance, null);
    assert.equal(state.distanceUsesTrunkAxis, null);
    return;
  }
  const axis = fs
    .readFileSync(path.join(directory, 'trunk.csv'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .find((columns) => Number(columns[0]) === state.treeId && columns.length >= 6);
  const tree = fs
    .readFileSync(path.join(directory, 'tree_centers2.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => Number(columns[0]) === state.treeId && columns.length >= 5);
  assert.ok(tree);
  const hasAxis = axis && Number.isFinite(Number(axis[4])) && Number.isFinite(Number(axis[5]));
  const x = Number(hasAxis ? axis[4] : tree[1]);
  const y = Number(hasAxis ? axis[5] : tree[2]);
  const expected = Math.hypot(x - Number(pose[1]), y - Number(pose[2]));
  assert.ok(Math.abs(state.cameraHorizontalDistance - expected) < 0.000001);
  assert.equal(state.distanceUsesTrunkAxis, Boolean(hasAxis));
}

async function waitReady(page) {
  await page.waitForFunction(() => !document.querySelector('#next-tree').disabled, null, {
    timeout: 90000,
  });
}

async function assertAndRevealPhoto(page) {
  const images = await page.evaluate(() => window.treeApp.images());
  const detection = images.photoPeopleDetection;
  const detected =
    detection?.status === 'complete' && (detection.personDetected || detection.headDetected);
  const cover = page.locator('#photo-risk-cover');
  const image = page.locator('#photo-image');
  assert.equal(await cover.isVisible(), Boolean(detected));
  assert.equal(await image.isVisible(), !detected);
  if (detected) {
    await page.locator('#photo-risk-reveal').click();
    assert.equal(await cover.isVisible(), false);
    assert.equal(await image.isVisible(), true);
  }
}

async function exerciseImageSafety(application, page) {
  const images = await page.evaluate(() => window.treeApp.images());
  assert.ok(images.photo && images.crop && images.panorama);
  const positive = { status: 'complete', personDetected: true, headDetected: true };
  const first = { ...images, photoPeopleDetection: positive, cropPeopleDetection: positive };
  const second = { ...first, photo: images.panorama, crop: images.photo };
  assert.notEqual(first.photo, second.photo);
  assert.notEqual(first.crop, second.crop);
  // 注入确定性模型状态和两张不同图片，只验证 UI 门控，不替代真实模型准确率验证。
  await application.evaluate(({ ipcMain }, payload) => {
    globalThis.testSafetyImages = payload;
    ipcMain.removeHandler('tree:images');
    ipcMain.handle('tree:images', async () => globalThis.testSafetyImages);
  }, first);
  await page.locator('#next-tree').click();
  await waitReady(page);
  for (const name of ['photo', 'crop']) {
    assert.equal(await page.locator(`#${name}-risk-cover`).isVisible(), true);
    assert.equal(await page.locator(`#${name}-image`).isVisible(), false);
    await page.locator(`#${name}-risk-reveal`).click();
    assert.equal(await page.locator(`#${name}-risk-cover`).isVisible(), false);
    assert.equal(await page.locator(`#${name}-image`).isVisible(), true);
  }
  await application.evaluate((_, payload) => {
    globalThis.testSafetyImages = payload;
  }, second);
  await page.locator('#next-tree').click();
  await waitReady(page);
  for (const name of ['photo', 'crop']) {
    assert.equal(await page.locator(`#${name}-risk-cover`).isVisible(), true);
    assert.equal(await page.locator(`#${name}-image`).isVisible(), false);
  }
}

async function main() {
  const application = await electron.launch({
    executablePath: require('electron'),
    args: [isolatedDesktop],
    cwd: isolatedDesktop,
    env: {
      ...process.env,
      TREEEXTRACT_DATA_DIR: temp,
      TREEEXTRACT_ZIP: path.join(sourceData, 'Camera4.zip'),
      TREEEXTRACT_TEST_HIDDEN: '1',
      TREEEXTRACT_TEST_USER_DATA: isolatedUserData,
      DOTNET_ROOT: path.join(temp, 'no-system-dotnet'),
      DOTNET_ROOT_X64: path.join(temp, 'no-system-dotnet'),
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
      { timeout: 90000 },
    );
    await page.waitForSelector('#pano-image.visible', { timeout: 90000 });
    await waitReady(page);
    assert.equal(await page.locator('.tree-row').count(), 228);
    const tree92 = await page.locator('.tree-row[data-index="92"]').innerText();
    assert.match(tree92, /# 92/);
    assert.match(tree92, /5\.1 m/);
    assert.doesNotMatch(tree92, /桃树/, '左侧不应展示原始文件中未经核实的树种');
    await page.locator('#tree-search').fill('桃树');
    assert.equal(await page.locator('.tree-row').count(), 0, '不应按原始树种搜索');
    await page.locator('#tree-search').fill('92');
    assert.equal(await page.locator('.tree-row[data-index="92"]').count(), 1);
    await page.locator('#tree-search').fill('');
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.treeApp.send), 'undefined');
    await page.screenshot({ path: path.join(artifacts, 'desktop-initial.png') });
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.screenshot({ path: path.join(artifacts, 'desktop-compact.png') });
    await page.setViewportSize({ width: 1524, height: 910 });

    const originalTree = await page.locator('#current-tree').innerText();
    await page.locator('#next-tree').click();
    await page.waitForFunction(
      (before) => document.querySelector('#current-tree').textContent !== before,
      originalTree,
      { timeout: 90000 },
    );
    await waitReady(page);

    // 选择没有历史人工校正的树，核对显示的是实际计算结果而非开关状态。
    const manuallyMarkedIds = new Set(
      fs
        .readFileSync(path.join(temp, 'manual_marks.csv'), 'utf8')
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.split(',')[0], 10))
        .filter(Number.isFinite),
    );
    const availableTrees = await page.evaluate(() => window.treeApp.trees());
    const unmarkedTree = availableTrees.find((tree) => !manuallyMarkedIds.has(tree.id));
    assert.ok(unmarkedTree);
    await page.locator(`.tree-row[data-index="${unmarkedTree.index}"]`).click();
    await waitReady(page);
    let desktopState = await page.evaluate(() => window.treeApp.state());
    assert.equal(desktopState.autoFrame, true);
    assert.equal(typeof desktopState.markAz, 'number');
    assert.equal(typeof desktopState.markEl, 'number');
    assert.equal(typeof desktopState.cameraHorizontalDistance, 'number');
    assert.equal(desktopState.targetValid, true);
    assert.match(await page.locator('#photo-details').innerText(), /水平距离/);
    assert.ok(
      ['unverified', 'prior-overlap', 'detected', 'detector-unavailable'].includes(
        desktopState.photoRisk.state,
      ),
    );
    assert.equal(await page.locator('#photo-risk-note').isVisible(), true);
    assert.equal(await page.locator('#photo-risk-note').innerText(), desktopState.photoRisk.reason);
    assert.match(desktopState.photoRisk.reason, /人工|核查/);
    assertHorizontalDistance(desktopState, temp);
    assert.ok(['success', 'fallback'].includes(desktopState.dualFrameInfo.state));
    assert.ok(Number.isInteger(desktopState.dualFrameInfo.attempts));
    assert.ok(desktopState.dualFrameInfo.attempts >= 0 && desktopState.dualFrameInfo.attempts <= 3);
    assert.ok(Array.isArray(desktopState.dualFrameInfo.attemptDetails));
    assert.ok(desktopState.dualFrameInfo.attemptDetails.length <= 3);
    if (desktopState.dualFrameInfo.attemptDetails.length > 0) {
      assert.equal(await page.locator('#dual-diagnostics').isVisible(), true);
      await page.locator('#dual-diagnostics-title').click();
      assert.equal(
        await page.locator('#dual-diagnostics-list li').count(),
        desktopState.dualFrameInfo.attemptDetails.length,
      );
      assert.match(await page.locator('#dual-diagnostics').innerText(), /不是识别准确率/);
      await page.locator('#dual-diagnostics-title').click();
    }
    assert.match(await page.locator('#dual-reason').innerText(), /辅助帧尝试 \d+ 次/);
    assert.equal(
      await page.locator('#dual-summary').getAttribute('data-state'),
      desktopState.dualFrameInfo.state,
    );
    assert.equal(desktopState.dualFrameInfo.frameA, desktopState.frame);
    assert.ok((await page.locator('#dual-frames').innerText()).includes(desktopState.frame));
    if (desktopState.dualFrameInfo.frameB) {
      assert.ok(
        (await page.locator('#dual-frames').innerText()).includes(
          desktopState.dualFrameInfo.frameB,
        ),
      );
    }
    await page.screenshot({ path: path.join(artifacts, 'desktop-dual-status.png') });

    // 默认数据的 130 号有辅助帧尝试，实际验证诊断面板而非仅覆盖空状态。
    await page.locator('.tree-row[data-index="130"]').click();
    await page.waitForFunction(() => document.querySelector('#current-tree').textContent === '130');
    await waitReady(page);
    const diagnosticState = await page.evaluate(() => window.treeApp.state());
    assert.ok(diagnosticState.dualFrameInfo.attemptDetails.length > 0);
    assert.equal(await page.locator('#dual-diagnostics').isVisible(), true);
    await page.locator('#dual-diagnostics-title').click();
    assert.equal(
      await page.locator('#dual-diagnostics-list li').count(),
      diagnosticState.dualFrameInfo.attemptDetails.length,
    );
    assert.match(await page.locator('#dual-diagnostics').innerText(), /不是识别准确率/);
    await page.screenshot({ path: path.join(artifacts, 'desktop-dual-diagnostics.png') });
    await page.locator('#dual-diagnostics-title').click();
    await page.locator(`.tree-row[data-index="${unmarkedTree.index}"]`).click();
    await page.waitForFunction(
      (id) => document.querySelector('#current-tree').textContent === String(id),
      unmarkedTree.id,
      { timeout: 90000 },
    );
    await waitReady(page);

    const frame = await page.locator('#frame-name').innerText();
    await page.locator('#nearest-tree').click();
    await waitReady(page);
    assert.equal(await page.locator('#frame-name').innerText(), frame);
    desktopState = await page.evaluate(() => window.treeApp.state());
    assertHorizontalDistance(desktopState, temp);
    assert.equal(
      await page.locator('#dual-summary').getAttribute('data-state'),
      desktopState.dualFrameInfo.state,
    );
    assert.equal(await page.locator('#dual-summary').getAttribute('data-frame-mode'), 'fixed');
    assert.match(await page.locator('#dual-frames').innerText(), /固定当前帧/);
    // 切回无人工记录的树，再检查开关和策略的真实状态。
    await page.locator(`.tree-row[data-index="${unmarkedTree.index}"]`).click();
    await waitReady(page);
    desktopState = await page.evaluate(() => window.treeApp.state());
    assertHorizontalDistance(desktopState, temp);
    const frameBeforeStep = desktopState.frame;
    await page.locator('#next-frame').click();
    await waitReady(page);
    desktopState = await page.evaluate(() => window.treeApp.state());
    assert.notEqual(desktopState.frame, frameBeforeStep);
    assertHorizontalDistance(desktopState, temp);
    await page.locator('#previous-frame').click();
    await waitReady(page);
    desktopState = await page.evaluate(() => window.treeApp.state());
    assert.equal(desktopState.frame, frameBeforeStep);
    assertHorizontalDistance(desktopState, temp);
    await page.locator('.settings-section > summary').click();
    assert.equal(await page.locator('#option-autoFrame').isChecked(), false);
    await page.locator('#option-dualFrame').uncheck();
    await waitReady(page);
    assert.equal(await page.locator('#dual-summary').getAttribute('data-state'), 'disabled');
    assert.match(await page.locator('#dual-result').innerText(), /已关闭/);
    await page.locator('#option-dualFrame').check();
    await waitReady(page);
    assert.notEqual(await page.locator('#dual-summary').getAttribute('data-state'), 'disabled');
    await page.locator('#option-frameStrategy').selectOption('nearest');
    await waitReady(page);
    const nearestFrameState = await page.evaluate(() => window.treeApp.state());
    assert.equal(nearestFrameState.frameStrategy, 'nearest');
    // 样本 D1 的树 1 最近相机距树干轴心约 1.50 m，应明确提示过近风险。
    assert.equal(nearestFrameState.treeId, 1);
    assert.equal(nearestFrameState.frame, '1788406067.251916.jpg');
    assert.equal(nearestFrameState.distanceUsesTrunkAxis, true);
    assert.ok(Math.abs(nearestFrameState.cameraHorizontalDistance - 1.499595755) < 0.00001);
    assert.equal(await page.locator('#distance-warning').isVisible(), true);
    assert.match(await page.locator('#distance-warning').innerText(), /建议切回“优质近帧”/);
    assert.equal(await page.locator('#option-autoFrame').isChecked(), true);
    assert.equal(await page.locator('#dual-summary').getAttribute('data-frame-mode'), 'auto');
    await page.screenshot({ path: path.join(artifacts, 'desktop-nearest-warning.png') });
    await page.locator('#option-frameStrategy').selectOption('quality');
    await waitReady(page);
    assert.equal((await page.evaluate(() => window.treeApp.state())).frameStrategy, 'quality');
    assert.equal(await page.locator('#distance-warning').isVisible(), false);
    await page.locator('#option-cal').fill('1.23');
    await page.locator('#option-cal').press('Tab');
    await waitReady(page);
    assert.equal(await page.locator('#option-cal').inputValue(), '1.23');
    await page.locator('#option-cal').fill('0');
    await page.locator('#option-cal').press('Tab');
    await waitReady(page);
    await page.locator('#option-distance').fill('');
    await page.locator('#option-distance').press('Tab');
    assert.match(await page.locator('#status-text').innerText(), /有效数值/);
    await page.locator('#option-lowDistortion').uncheck();
    await waitReady(page);
    assert.equal(await page.locator('#option-lowDistortion').isChecked(), false);
    await page.locator('#option-lowDistortion').check();
    await waitReady(page);

    const panoBounds = await page.locator('#pano-image').boundingBox();
    await page.mouse.move(
      panoBounds.x + panoBounds.width / 2,
      panoBounds.y + panoBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      panoBounds.x + panoBounds.width / 2 + 60,
      panoBounds.y + panoBounds.height / 2,
    );
    await page.mouse.up();
    await waitReady(page);
    assert.equal(await page.locator('#option-lockView').isChecked(), false);

    await page.locator('#edit-mark').click();
    await assertAndRevealPhoto(page);
    await page.locator('#photo-image').click();
    await page.waitForFunction(
      () => document.querySelector('#save-mark').textContent.includes('未保存'),
      null,
      { timeout: 90000 },
    );
    await waitReady(page);
    assert.equal(await page.locator('#dual-summary').getAttribute('data-state'), 'manual');
    assert.match(await page.locator('#dual-result').innerText(), /人工校正优先/);
    await page.locator('#save-mark').click();
    await page.waitForFunction(
      () => !document.querySelector('#save-mark').textContent.includes('未保存'),
      null,
      { timeout: 90000 },
    );
    await waitReady(page);
    assert.equal(hash(path.join(sourceData, 'manual_marks.csv')), originalMarks);
    assert.equal(hash(path.join(sourceData, 'tree_centers2.txt')), originalTrees);
    await page.locator('#pano-image').click();
    await page.waitForFunction(
      () => document.querySelector('#save-mark').textContent.includes('未保存'),
      null,
      { timeout: 90000 },
    );
    await waitReady(page);
    await page.locator('#save-mark').click();
    await waitReady(page);

    await page.locator('#recognize').click();
    await page.waitForSelector('#heat-image.visible', { timeout: 90000 });
    await waitReady(page);
    assert.match(await page.locator('#recognition-result').innerText(), /树种/);
    await page.screenshot({ path: path.join(artifacts, 'desktop-recognition.png') });
    await page.locator('#next-tree').click();
    await waitReady(page);
    assert.equal(await page.locator('#heat-image').isVisible(), false);
    assert.match(await page.locator('#recognition-result').innerText(), /选择树木/);

    const crop = path.join(temp, 'export.png');
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      globalThis.cropReviewReached = new Promise((resolve) => {
        dialog.showMessageBox = async () => {
          resolve();
          return { response: 0 };
        };
      });
    }, crop);
    await page.locator('#save-crop').click();
    await application.evaluate(() => globalThis.cropReviewReached);
    assert.equal(fs.existsSync(crop), false, '取消人工核查不应写出切图');
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    await page.locator('#save-crop').click();
    await page.waitForFunction(
      (file) => document.querySelector('#status-text').textContent.includes(file),
      crop,
      { timeout: 90000 },
    );
    assert.ok(fs.statSync(crop).size > 1000);

    await page.locator('#open-table').click();
    await page.waitForSelector('#table-dialog[open]', { timeout: 90000 });
    assert.equal(await page.locator('#table-body tr').count(), 228);
    await page.screenshot({ path: path.join(artifacts, 'desktop-table.png') });
    const xlsx = path.join(temp, 'export.xlsx');
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, xlsx);
    await page.locator('#export-xlsx').click();
    await page.waitForFunction(
      (file) => document.querySelector('#status-text').textContent.includes(file),
      xlsx,
      { timeout: 90000 },
    );
    assert.equal(fs.readFileSync(xlsx).subarray(0, 2).toString('ascii'), 'PK');
    await page.locator('#table-body tr').first().dblclick();
    await waitReady(page);
    assert.equal(await page.locator('#table-dialog').evaluate((dialog) => dialog.open), false);

    // 切换真实数据集时，水平距离必须跟随新的树和相机，不能沿用上一套数值。
    const secondSource = path.resolve(project, '..', 'dataset_runtime', 'data');
    if (fs.existsSync(path.join(secondSource, 'Camera4.zip'))) {
      const secondTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-ui-dataset-'));
      for (const name of files)
        fs.copyFileSync(path.join(secondSource, name), path.join(secondTemp, name));
      const secondMarksHash = hash(path.join(secondSource, 'manual_marks.csv'));
      async function chooseDataset(directory, zip, expectedCount) {
        await application.evaluate(({ dialog }, target) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
        }, directory);
        await page.locator('#choose-data').click();
        await page.waitForFunction(
          () => document.querySelector('#connection-label').textContent === '需要处理',
          null,
          { timeout: 90000 },
        );
        await application.evaluate(({ dialog }, target) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
        }, zip);
        await page.locator('#choose-zip').click();
        await page.waitForFunction(
          (count) => document.querySelector('#summary-trees').textContent === String(count),
          expectedCount,
          { timeout: 90000 },
        );
        await waitReady(page);
        const selectedState = await page.evaluate(() => window.treeApp.state());
        assertHorizontalDistance(selectedState, directory);
      }
      await chooseDataset(secondTemp, path.join(secondSource, 'Camera4.zip'), 275);
      await chooseDataset(temp, path.join(sourceData, 'Camera4.zip'), 228);
      assert.equal(hash(path.join(secondSource, 'manual_marks.csv')), secondMarksHash);
    }

    // 原生文件选择器失败时显示可理解的错误，且不清空当前会话。
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => {
        throw new Error('simulated selector failure');
      };
    });
    await page.locator('#choose-data').click();
    await page.waitForFunction(() =>
      document.querySelector('#status-text').textContent.includes('无法打开数据目录选择窗口'),
    );
    assert.equal((await page.evaluate(() => window.treeApp.state())).loaded, true);

    // 全景包损坏时不得切换会话；保留并明确显示原数据，而不是把旧画面冒充新数据。
    const beforeBadZip = await page.evaluate(() => window.treeApp.state());
    const invalidZip = path.join(temp, 'invalid.zip');
    fs.writeFileSync(invalidZip, 'not a zip archive', 'utf8');
    await application.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, invalidZip);
    await page.locator('#choose-zip').click();
    await page.waitForFunction(
      () => document.querySelector('#status-text').textContent.includes('未切换数据'),
      null,
      { timeout: 90000 },
    );
    assert.equal(await page.locator('.tree-row').count(), 228);
    assert.equal(await page.locator('#pano-image').isVisible(), true);
    assert.equal(await page.locator('#next-tree').isDisabled(), false);
    assert.match(await page.locator('#status-text').innerText(), /未切换数据/);
    const afterBadZip = await page.evaluate(() => window.treeApp.state());
    assert.equal(afterBadZip.dataDir, beforeBadZip.dataDir);
    assert.equal(afterBadZip.zipPath, beforeBadZip.zipPath);
    assert.equal(afterBadZip.treeId, beforeBadZip.treeId);
    assert.equal(afterBadZip.frame, beforeBadZip.frame);
    await application.evaluate(
      ({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      },
      path.join(sourceData, 'Camera4.zip'),
    );
    await page.locator('#choose-zip').click();
    await waitReady(page);
    assert.equal(await page.locator('.tree-row').count(), 228);
    await page.waitForSelector('#pano-image.visible', { timeout: 90000 });
    assertHorizontalDistance(await page.evaluate(() => window.treeApp.state()), temp);

    // 真实缺位姿帧：保留全景，但不能显示上一帧的 4:3 照片、切图和角度。
    await page.locator('.tree-row[data-index="120"]').click();
    await page.waitForFunction(() => document.querySelector('#current-tree').textContent === '120');
    await waitReady(page);
    if (!(await page.locator('.settings-section').evaluate((section) => section.open))) {
      await page.locator('.settings-section > summary').click();
    }
    await page.locator('#option-frameStrategy').selectOption('nearest');
    await page.waitForFunction(
      () => document.querySelector('#frame-name').textContent === '1788406083.267687.jpg',
      null,
      { timeout: 90000 },
    );
    await waitReady(page);
    for (let step = 0; step < 10; step++) {
      const previous = await page.locator('#frame-name').innerText();
      await page.locator('#previous-frame').click();
      await page.waitForFunction(
        (frame) => document.querySelector('#frame-name').textContent !== frame,
        previous,
        { timeout: 90000 },
      );
      await waitReady(page);
    }
    const missingPose = await page.evaluate(() => window.treeApp.state());
    assert.equal(missingPose.frame, '1788406073.257830.jpg');
    assert.equal(missingPose.framePoseAvailable, false);
    assert.equal(missingPose.targetValid, false);
    assert.equal(missingPose.markAz, null);
    assert.equal(missingPose.markEl, null);
    assert.equal(await page.locator('#pano-image').isVisible(), true);
    assert.equal(await page.locator('#photo-image').isVisible(), false);
    assert.equal(await page.locator('#crop-image').isVisible(), false);
    assert.match(await page.locator('#photo-details').innerText(), /方位 —.*仰角 —/);
    assert.match(await page.locator('#photo-risk-note').innerText(), /缺少完整相机位姿/);
    assert.equal(await page.locator('#option-bearing').inputValue(), '');
    assert.equal(await page.locator('#option-distance').inputValue(), '');
    assert.equal(await page.locator('#option-elevation').inputValue(), '');
    await page.locator('.tree-row[data-index="121"]').click();
    await page.waitForFunction(() => document.querySelector('#current-tree').textContent === '121');
    await waitReady(page);
    assert.equal((await page.evaluate(() => window.treeApp.state())).autoFrame, true);
    await assertAndRevealPhoto(page);

    assert.deepEqual(errors, []);
    assert.equal(hash(path.join(sourceData, 'manual_marks.csv')), originalMarks);
    if ((await page.locator('#edit-mark').getAttribute('aria-pressed')) !== 'true') {
      await page.locator('#edit-mark').click();
    }
    await page.locator('#photo-image').click();
    await page.waitForFunction(
      () => document.querySelector('#save-mark').textContent.includes('未保存'),
      null,
      { timeout: 90000 },
    );
    await waitReady(page);
    await exerciseImageSafety(application, page);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2 });
    });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForTimeout(500);
    assert.equal(page.isClosed(), false);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    });
    const closed = application.waitForEvent('close', { timeout: 90000 });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    assert.equal(hash(path.join(sourceData, 'manual_marks.csv')), originalMarks);
    console.log(`UI SMOKE PASS; isolated data: ${temp}`);
    console.log(`Screenshots: ${artifacts}`);
  } finally {
    await application.evaluate(({ app }) => app.exit()).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
