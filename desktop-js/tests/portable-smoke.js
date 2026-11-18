'use strict';

// 启动单文件 EXE 或隔离的目录版，通过 Chrome DevTools 验证实际打包的界面。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const asar = require('@electron/asar');
const { assertIsolatedUnpackedExecutable } = require('./packaged-test-safety');

const desktop = path.resolve(__dirname, '..');
const project = path.resolve(desktop, '..');
const source = path.resolve(project, '..', 'tree');
const executable = path.resolve(
  process.argv[2] || path.join(desktop, 'release-net10', 'TreeExtract-Portable.exe'),
);
const isDirectoryBuild = assertIsolatedUnpackedExecutable(executable);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract portable test '));
const dataDir = path.join(temp, 'sample data');
const extractionDir = path.join(temp, 'runtime with spaces');
const isolatedUserData = path.join(temp, 'user-data');
fs.mkdirSync(dataDir);
fs.mkdirSync(extractionDir);
fs.mkdirSync(isolatedUserData);

for (const name of [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
]) {
  fs.copyFileSync(path.join(source, name), path.join(dataDir, name));
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertPackagedRenderer(archive) {
  const archiveFiles = asar
    .listPackage(archive)
    .map((name) => name.replace(/\\/g, '/').replace(/^\//, ''))
    .filter((name) => !asar.statFile(archive, name.split('/').join(path.sep)).files);
  const expected = ['package.json'];
  function collect(directory, relative) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) collect(path.join(directory, entry.name), name);
      else if (entry.isFile()) expected.push(name);
      else throw new Error(`Unexpected source entry: ${name}`);
    }
  }
  collect(path.join(desktop, 'src'), 'src');
  assert.deepEqual(archiveFiles.sort(), expected.sort(), '打包界面文件清单与源码不一致');
  for (const name of expected.filter((entry) => entry.startsWith('src/'))) {
    assert.ok(
      asar
        .extractFile(archive, name.split('/').join(path.sep))
        .equals(fs.readFileSync(path.join(desktop, name))),
      `打包界面文件与源码不一致: ${name}`,
    );
  }
  // electron-builder intentionally removes development scripts and dependencies.
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  const source = require('../package.json');
  for (const key of ['name', 'version', 'main']) assert.equal(packaged[key], source[key]);
}

async function availablePort() {
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
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Executable exited early: ${child.exitCode}`);
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 1500 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Timed out waiting for the portable executable to start.');
}

async function runPortable(useIsolatedData) {
  const port = await availablePort();
  const env = {
    ...process.env,
    TEMP: extractionDir,
    TMP: extractionDir,
    DOTNET_ROOT: path.join(temp, 'no-system-dotnet'),
    DOTNET_ROOT_X64: path.join(temp, 'no-system-dotnet'),
    DOTNET_MULTILEVEL_LOOKUP: '0',
    TREEEXTRACT_TEST_HIDDEN: '1',
    TREEEXTRACT_TEST_USER_DATA: isolatedUserData,
  };
  delete env.TREEEXTRACT_DATA_DIR;
  delete env.TREEEXTRACT_ZIP;
  if (useIsolatedData) {
    env.TREEEXTRACT_DATA_DIR = dataDir;
    env.TREEEXTRACT_ZIP = path.join(source, 'Camera4.zip');
  }

  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env,
    windowsHide: true,
    stdio: 'ignore',
  });
  let browser;
  try {
    browser = await connect(port, child);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 30000 }));
    await page.waitForFunction(
      () => document.querySelector('#summary-trees')?.textContent === '228',
      null,
      { timeout: 90000 },
    );
    await page.waitForSelector('#pano-image.visible', { timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
    await page.locator('#open-merge').click();
    assert.equal(await page.locator('#merge-dialog').isVisible(), true, '打包程序缺少合并界面');
    assert.equal(await page.locator('#merge-run').isDisabled(), true, '未分析前不能合并');
    await page.locator('#merge-close').click();
    const tree92 = await page.locator('.tree-row[data-index="92"]').innerText();
    assert.match(tree92, /# 92/);
    assert.match(tree92, /5\.1 m/);
    assert.doesNotMatch(tree92, /桃树/, '便携包不应显示原始文件中的错误树种');
    await page.locator('#tree-search').fill('桃树');
    assert.equal(await page.locator('.tree-row').count(), 0);
    await page.locator('#tree-search').fill('92');
    assert.equal(await page.locator('.tree-row[data-index="92"]').count(), 1);
    await page.locator('#tree-search').fill('');
    assert.equal(await page.locator('#species-choice option').count(), 122, '树种目录未完整打包');
    assert.equal(await page.locator('#species-key').inputValue(), '', '密钥输入框不应预填');
    if (!useIsolatedData) {
      assert.equal(await page.locator('#data-name').innerText(), 'tree');
    } else {
      // 使用复制的数据测试打包产物中的去重与提示，而非只验证开发源码。
      const frames = [];
      for (const tree of [106, 107]) {
        await page.locator(`.tree-row[data-index="${tree}"]`).click();
        await page.waitForFunction(
          (id) =>
            document.querySelector('#current-tree').textContent === String(id) &&
            !document.querySelector('#next-tree').disabled,
          tree,
          { timeout: 90000 },
        );
        frames.push(await page.locator('#frame-name').innerText());
      }
      assert.ok(frames.every((name) => name && name.endsWith('.jpg')));
      assert.notEqual(frames[0], frames[1], '打包程序不能把同一自动主帧分给 106 和 107');
      assert.match(await page.locator('#distance-warning').innerText(), /邻树 106.*人工核查/);
      // 真实打包程序也应包含最近相机模式，而非仅开发目录中生效。
      await page.locator('.tree-row[data-index="1"]').click();
      await page.waitForFunction(() => document.querySelector('#current-tree').textContent === '1');
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
      await page.locator('.settings-section > summary').click();
      await page.locator('#option-frameStrategy').selectOption('nearest');
      await page.waitForFunction(
        () => document.querySelector('#frame-name').textContent === '1788406067.251916.jpg',
        null,
        { timeout: 90000 },
      );
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
      assert.equal(await page.locator('#distance-warning').isVisible(), true);
      assert.match(await page.locator('#dual-result').innerText(), /双帧/);
      await page.locator('.tree-row[data-index="120"]').click();
      await page.waitForFunction(
        () => document.querySelector('#current-tree').textContent === '120',
      );
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
      await page.locator('#next-frame').click();
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
      const fixed = await page.evaluate(() => window.treeApp.state());
      assert.equal(fixed.autoFrame, false);
      await page.locator('.tree-row[data-index="170"]').click();
      await page.waitForFunction(
        () => document.querySelector('#current-tree').textContent === '170',
      );
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
      const switched = await page.evaluate(() => window.treeApp.state());
      assert.equal(switched.autoFrame, true);
      assert.equal(switched.framePoseAvailable, true);
      assert.notEqual(switched.frame, fixed.frame);
      assert.ok(switched.cameraHorizontalDistance < 20);
      assert.match(switched.photoRisk.reason, /人工|核查/);
      assert.equal(await page.locator('#photo-risk-note').isVisible(), true);
      await page.locator('.tree-row[data-index="1"]').click();
      await page.waitForFunction(() => document.querySelector('#current-tree').textContent === '1');
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
      await page.locator('#nearest-tree').click();
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
      await page.locator('#recognize').click();
      await page.waitForSelector('#heat-image.visible', { timeout: 90000 });
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
      assert.match(await page.locator('#recognition-result').innerText(), /树种/);
      const species = await page.evaluate(async () => {
        const context = await window.treeApp.speciesContext();
        const preview = await window.treeApp.speciesPreview(context.scope);
        try {
          const bytes = Uint8Array.from(atob(preview.image.split(',')[1]), (letter) =>
            letter.charCodeAt(0),
          );
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('');
          return { scope: context.scope, previewSha256: digest };
        } finally {
          await window.treeApp.speciesCancelPreview();
        }
      });
      assert.match(species.scope.datasetFingerprint, /^[a-f0-9]{64}$/);
      assert.equal(
        species.previewSha256,
        species.scope.imageSha256,
        '便携包中的干净切图摘要不一致',
      );
      if (await page.locator('#photo-risk-cover').isVisible()) {
        assert.equal(await page.locator('#photo-image').isVisible(), false);
        await page.locator('#photo-risk-reveal').click();
      }
      await page.locator('#edit-mark').click();
      await page.locator('#photo-image').click();
      await page.waitForFunction(() =>
        document.querySelector('#save-mark').textContent.includes('未保存'),
      );
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
      await page.locator('#save-mark').click();
      await page.waitForFunction(
        () => !document.querySelector('#save-mark').textContent.includes('未保存'),
      );
      await page.waitForFunction(() => !document.querySelector('#next-tree').disabled);
    }
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    browser = null;
    if (child.exitCode === null) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Portable executable did not close.')),
          30000,
        );
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    assert.equal(child.exitCode, 0);
  } finally {
    if (browser) await browser.close().catch(() => {});
    // 只终止当前测试启动的进程树，不影响用户打开的其他应用。
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  }
}

async function main() {
  assert.ok(fs.existsSync(executable), 'Build the portable executable first.');
  // 目录版检查实际启动的副本；单文件版没有保留打包暂存时，仍可独立做启动测试。
  const directory = path.dirname(executable);
  const resources = path.join(
    isDirectoryBuild ? directory : path.join(directory, 'win-unpacked'),
    'resources',
  );
  const packagedRuntime = path.join(resources, 'runtime');
  const packagedAsar = path.join(resources, 'app.asar');
  if (fs.existsSync(packagedAsar)) assertPackagedRenderer(packagedAsar);
  else console.log('NOT RUN: unpacked ASAR/source comparison (unpacked staging directory absent).');
  if (fs.existsSync(packagedRuntime)) {
    for (const name of [
      'TreeExtractorBridge.exe',
      'TreeExtractorBridge.dll',
      'coreclr.dll',
      'hostfxr.dll',
      'onnxruntime.dll',
      'models/tree_cls.onnx',
      'models/person_head.onnx',
      'models/PERSON_HEAD_LICENSE.txt',
    ]) {
      assert.ok(fs.existsSync(path.join(packagedRuntime, name)), `打包缺少 ${name}`);
    }
    for (const name of ['data', 'outputs', 'manual_marks.csv', 'TreeExtractor.ini', 'error.log']) {
      assert.equal(fs.existsSync(path.join(packagedRuntime, name)), false, `不应打包 ${name}`);
    }
    assert.equal(
      hash(path.join(packagedRuntime, 'models/person_head.onnx')),
      '7dd9b514426b33423ffbc4e22fb6127f2145686441f2c398170585363c009575',
      '人像模型内容与已验证版本不一致',
    );
    if (process.env.TREEEXTRACT_TEST_BRIDGE) {
      const candidateDll = path.join(
        path.dirname(process.env.TREEEXTRACT_TEST_BRIDGE),
        'TreeExtractorBridge.dll',
      );
      assert.equal(
        hash(path.join(packagedRuntime, 'TreeExtractorBridge.dll')),
        hash(candidateDll),
        '打包后端与已验收的隔离候选不一致',
      );
    }
    const config = JSON.parse(
      fs.readFileSync(path.join(packagedRuntime, 'TreeExtractorBridge.runtimeconfig.json'), 'utf8'),
    );
    assert.equal(config.runtimeOptions.tfm, 'net10.0');
    assert.ok(
      config.runtimeOptions.includedFrameworks.some(
        (item) => item.name === 'Microsoft.NETCore.App',
      ),
    );
  }
  const originalMarks = hash(path.join(source, 'manual_marks.csv'));
  await runPortable(false);
  await runPortable(true);
  assert.equal(hash(path.join(source, 'manual_marks.csv')), originalMarks);
  console.log('PACKAGED SMOKE PASS: default data, isolated data, recognition and mark saving');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
