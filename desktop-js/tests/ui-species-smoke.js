'use strict';

// 使用真实本地切图但拦截全部云端请求；不会向网络发送图片，也不打印图片。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { copyRuntime } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const source = process.env.TREEEXTRACT_UI_TEST_DATA || path.resolve(desktop, '..', '..', 'tree');
const zip = path.join(source, 'Camera4.zip');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-species-ui-'));
const isolatedDesktop = path.join(temporary, 'desktop');
const isolatedData = path.join(temporary, 'data');
const userData = path.join(temporary, 'user-data');
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
fs.mkdirSync(userData);
fs.cpSync(path.join(desktop, 'src'), path.join(isolatedDesktop, 'src'), { recursive: true });
fs.copyFileSync(path.join(desktop, 'package.json'), path.join(isolatedDesktop, 'package.json'));
copyRuntime(
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe'),
  path.join(isolatedDesktop, 'runtime'),
);
for (const name of inputs) fs.copyFileSync(path.join(source, name), path.join(isolatedData, name));
const originalTreeData = fs.readFileSync(path.join(isolatedData, 'tree_centers2.txt'));

async function run() {
  const launchOptions = {
    executablePath: require('electron'),
    args: [isolatedDesktop],
    cwd: isolatedDesktop,
    env: {
      ...process.env,
      TREEEXTRACT_DATA_DIR: isolatedData,
      TREEEXTRACT_ZIP: zip,
      TREEEXTRACT_TEST_HIDDEN: '1',
      TREEEXTRACT_TEST_USER_DATA: userData,
    },
    timeout: 60000,
  };
  const application = await electron.launch(launchOptions);
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ app, dialog }, directory) => {
      app.setPath('userData', directory);
      globalThis.speciesConsent = false;
      globalThis.speciesSaveConsent = false;
      globalThis.speciesRequests = [];
      dialog.showMessageBox = async (_window, options) => ({
        response:
          (options.title === '确认上传当前切图' && globalThis.speciesConsent) ||
          (options.title === '确认保存人工树种' && globalThis.speciesSaveConsent)
            ? 1
            : 0,
      });
      globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        const text = JSON.stringify(body);
        const imagePart = body.messages
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .find((part) => part.type === 'image_url');
        const imageHash = imagePart
          ? Buffer.from(
              await globalThis.crypto.subtle.digest(
                'SHA-256',
                Buffer.from(imagePart.image_url.url.split(',')[1], 'base64'),
              ),
            ).toString('hex')
          : null;
        globalThis.speciesRequests.push({
          url,
          imageHash,
          hasLocal: text.includes('候选：'),
          containsKey: text.includes('test-placeholder-key'),
          containsPath: text.includes(directory),
          containsImage: Boolean(imagePart),
        });
        const result = imagePart
          ? {
              group: '常绿乔木',
              value: 'zhangshu',
              reason: '测试视觉证据',
              uncertainty: '仅为模拟',
            }
          : {
              suggestedGroup: '常绿乔木',
              suggestedValue: 'zhangshu',
              opinion: '测试复核',
              differences: '请人工核查',
              uncertainty: '仅为模拟',
            };
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      };
    }, userData);
    await page.waitForFunction(
      () =>
        document.querySelector('#summary-trees').textContent === '228' &&
        !document.querySelector('#recognize').disabled,
      null,
      {
        timeout: 90000,
      },
    );
    const subframeResult = await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = 'treeextract://app/index.html';
      document.body.append(frame);
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            frame.onload = resolve;
            frame.onerror = reject;
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('subframe timeout')), 10000),
          ),
        ]);
        if (!frame.contentWindow.treeApp) return 'no-bridge';
        try {
          await frame.contentWindow.treeApp.speciesCatalog();
          return 'allowed';
        } catch {
          return 'blocked';
        }
      } finally {
        frame.remove();
      }
    });
    assert.notEqual(subframeResult, 'allowed', '子帧不得调用受保护的 IPC');
    assert.equal(await page.locator('#species-other-label').isVisible(), false);
    await page.locator('#species-choice').selectOption('__other__');
    assert.equal(await page.locator('#species-other-label').isVisible(), true);
    await page.locator('#species-choice').selectOption('');
    await page.locator('#recognize').click();
    await page.waitForFunction(
      () => document.querySelector('#recognition-result').textContent.includes('候选：'),
      null,
      { timeout: 120000 },
    );
    await page.waitForFunction(
      () => !document.querySelector('#recognize').hasAttribute('aria-busy'),
    );
    await page.locator('#species-key').fill('test-placeholder-key');
    await page.locator('#species-key-save').click();
    await page.waitForFunction(
      () => document.querySelector('#species-key-status').textContent.includes('加密保存'),
      null,
      { timeout: 30000 },
    );
    assert.equal(await page.locator('#species-key').inputValue(), '');
    assert.equal(
      fs
        .readFileSync(path.join(userData, 'cloud-credentials', 'deepseek.dat'))
        .includes(Buffer.from('test-placeholder-key')),
      false,
    );
    const expected = await page.evaluate(() => window.treeApp.speciesContext());
    async function openPreview() {
      await page.locator('#recognize').click();
      await page.waitForFunction(
        () => document.querySelector('#species-preview-dialog').open,
        null,
        { timeout: 30000 },
      );
      if (await page.locator('#species-preview-cover').isVisible()) {
        assert.equal(await page.locator('#species-preview-image').getAttribute('src'), null);
        await page.locator('#species-preview-reveal').click();
      }
      const previewHash = await page.locator('#species-preview-image').evaluate(async (image) => {
        const bytes = Uint8Array.from(atob(image.src.split(',')[1]), (letter) =>
          letter.charCodeAt(0),
        );
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('');
      });
      assert.equal(previewHash, expected.scope.imageSha256, '人工预览必须是实际上传的干净切图');
      assert.equal(await page.locator('#species-preview-approve').isDisabled(), true);
    }
    await openPreview();
    await page.locator('#species-preview-cancel').click();
    await page.waitForFunction(
      () => !document.querySelector('#recognize').hasAttribute('aria-busy'),
    );
    assert.equal((await application.evaluate(() => globalThis.speciesRequests)).length, 0);
    await openPreview();
    await page.locator('#species-reviewed').check();
    await page.locator('#species-preview-approve').click();
    await page.waitForFunction(
      () => !document.querySelector('#recognize').hasAttribute('aria-busy'),
      null,
      {
        timeout: 30000,
      },
    );
    assert.equal(
      (await application.evaluate(() => globalThis.speciesRequests)).length,
      0,
      '取消上传不能联网',
    );
    assert.equal(await page.locator('#species-key').inputValue(), '', '密钥输入应及时清空');
    await application.evaluate(() => {
      globalThis.speciesConsent = true;
    });
    await openPreview();
    await page.locator('#species-reviewed').check();
    await page.locator('#species-preview-approve').click();
    try {
      await page.waitForFunction(
        () => document.querySelector('#species-synthesis').textContent.includes('测试复核'),
        null,
        { timeout: 30000 },
      );
    } catch (error) {
      console.error('UI diagnostic:', await page.locator('#status-text').textContent());
      console.error('Mock calls:', await application.evaluate(() => globalThis.speciesRequests));
      throw error;
    }
    const calls = await application.evaluate(() => globalThis.speciesRequests);
    assert.match(await page.locator('#species-visual').innerText(), /名称比对/);
    assert.match(await page.locator('#species-final').innerText(), /常绿乔木 → 香樟/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].imageHash, expected.scope.imageSha256);
    assert.equal(calls[0].hasLocal, false);
    assert.equal(calls[1].hasLocal, true);
    assert.equal(calls[1].containsImage, false);
    assert.ok(calls.every((call) => !call.containsKey && !call.containsPath));
    await openPreview();
    assert.doesNotMatch(await page.locator('#species-synthesis').innerText(), /测试复核/);
    await page.locator('#species-preview-cancel').click();
    await page.waitForFunction(
      () => !document.querySelector('#recognize').hasAttribute('aria-busy'),
    );
    assert.match(await page.locator('#species-final').innerText(), /已取消云端上传/);
    await page.locator('#species-choice').selectOption('zhangshu');
    await page.locator('#species-save').click();
    await page.waitForFunction(() => !document.querySelector('#species-save').disabled);
    assert.equal((await page.evaluate(() => window.treeApp.speciesContext())).record, null);
    await application.evaluate(() => {
      globalThis.speciesSaveConsent = true;
    });
    await page.locator('#species-save').click();
    await page.waitForFunction(
      () => document.querySelector('#species-saved').textContent.includes('香樟'),
      null,
      { timeout: 30000 },
    );
    const stored = await page.evaluate(() => window.treeApp.speciesContext());
    assert.equal(stored.record.choice.value, 'zhangshu');
    assert.equal(stored.record.confirmedBy, 'human');
    await assert.rejects(
      page.evaluate(() => window.treeApp.speciesSave({ scope: {}, value: 'elm' })),
    );
    await assert.rejects(page.evaluate(() => window.treeApp.speciesAnalyze(false, {})));
    await assert.rejects(page.evaluate(() => window.treeApp.speciesAnalyze(true, {})));
    assert.equal((await application.evaluate(() => globalThis.speciesRequests)).length, 2);
    assert.equal(
      (await page.evaluate(() => window.treeApp.speciesContext())).record.choice.value,
      'zhangshu',
    );
    const records = path.join(userData, 'species-confirmations');
    const recordFile = path.join(
      records,
      fs.readdirSync(records).find((name) => name.endsWith('.json')),
    );
    const originalRecord = fs.readFileSync(recordFile);
    fs.writeFileSync(recordFile, 'invalid');
    const damaged = await page.evaluate(() => window.treeApp.speciesContext());
    assert.ok(damaged.recordError && damaged.scope);
    assert.equal(
      await page.evaluate(async (scope) => {
        const preview = await window.treeApp.speciesPreview(scope);
        await window.treeApp.speciesCancelPreview();
        return Boolean(preview.image);
      }, damaged.scope),
      true,
    );
    await assert.rejects(
      page.evaluate((scope) => window.treeApp.speciesSave({ scope, value: 'elm' }), damaged.scope),
    );
    assert.equal(fs.readFileSync(recordFile, 'utf8'), 'invalid');
    await openPreview();
    await page.locator('#species-reviewed').check();
    await page.locator('#species-preview-approve').click();
    await page.waitForFunction(
      () => !document.querySelector('#recognize').hasAttribute('aria-busy'),
      null,
      { timeout: 30000 },
    );
    assert.equal(
      (await application.evaluate(() => globalThis.speciesRequests)).length,
      4,
      '坏记录不能阻断模拟云端分析',
    );
    assert.match(await page.locator('#species-saved').innerText(), /损坏/);
    fs.writeFileSync(recordFile, originalRecord);
    await page.locator('#species-choice').selectOption('__other__');
    await page.locator('#species-other').fill('临时草稿');
    await page.locator('#next-tree').click();
    await page.waitForFunction(
      () => document.querySelector('#species-visual').textContent.includes('尚未请求'),
      null,
      { timeout: 90000 },
    );
    assert.equal(await page.locator('#species-choice').inputValue(), '');
    assert.doesNotMatch(await page.locator('#species-saved').innerText(), /已保存人工确认：香樟/);
    await page.locator('#previous-tree').click();
    await page.waitForFunction(
      () => document.querySelector('#species-other').value === '临时草稿',
      null,
      { timeout: 90000 },
    );
    assert.match(await page.locator('#species-visual').innerText(), /尚未请求/);
    fs.appendFileSync(path.join(isolatedData, 'tree_centers2.txt'), '\n');
    await assert.rejects(
      page.evaluate(() => window.treeApp.speciesContext()),
      /重新加载/,
    );
    await page.evaluate(({ data, zipPath }) => window.treeApp.load(data, zipPath), {
      data: isolatedData,
      zipPath: zip,
    });
    const replaced = await page.evaluate(() => window.treeApp.speciesContext());
    assert.notEqual(replaced.scope.datasetFingerprint, expected.scope.datasetFingerprint);
    assert.equal(replaced.record, null, '同路径替换数据后不能沿用旧记录');
  } finally {
    await application.evaluate(({ app }) => app.exit()).catch(() => {});
    for (const name of inputs) assert.equal(hash(path.join(source, name)), hashes[name]);
    const afterZip = fs.statSync(zip);
    assert.equal(afterZip.size, originalZip.size);
    assert.equal(afterZip.mtimeMs, originalZip.mtimeMs);
  }
  // 恢复隔离副本并重启独立进程，验证用户确认不是只存在于内存。
  fs.writeFileSync(path.join(isolatedData, 'tree_centers2.txt'), originalTreeData);
  const restarted = await electron.launch(launchOptions);
  try {
    await restarted.evaluate(({ app, dialog }, directory) => {
      app.setPath('userData', directory);
      globalThis.restartedMockCalls = 0;
      dialog.showMessageBox = async () => ({ response: 1 });
      globalThis.fetch = async (_url, options) => {
        globalThis.restartedMockCalls += 1;
        const body = JSON.parse(options.body);
        const visual = body.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === 'image_url'),
        );
        const result = visual
          ? { group: '常绿乔木', value: 'zhangshu', reason: 'mock', uncertainty: 'mock' }
          : {
              suggestedGroup: '常绿乔木',
              suggestedValue: 'zhangshu',
              opinion: 'mock',
              differences: 'mock',
              uncertainty: 'mock',
            };
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
          }),
          { status: 200 },
        );
      };
    }, userData);
    const page = await restarted.firstWindow();
    await page.waitForFunction(
      () =>
        document.querySelector('#summary-trees').textContent === '228' &&
        !document.querySelector('#recognize').disabled,
      null,
      {
        timeout: 90000,
      },
    );
    const restored = await page.evaluate(() => window.treeApp.speciesContext());
    assert.equal(restored.record.choice.value, 'zhangshu', '重启后应读取人工确认记录');
    assert.equal(
      (await page.evaluate(() => window.treeApp.speciesCredentialStatus())).configured,
      true,
    );
    assert.equal(await page.locator('#species-key').inputValue(), '');
    await page.locator('#recognize').click();
    await page.waitForFunction(() => document.querySelector('#species-preview-dialog').open, null, {
      timeout: 30000,
    });
    if (await page.locator('#species-preview-cover').isVisible())
      await page.locator('#species-preview-reveal').click();
    await page.locator('#species-reviewed').check();
    await page.locator('#species-preview-approve').click();
    await page.waitForFunction(
      () => document.querySelector('#species-final').textContent.includes('常绿乔木 → 香樟'),
      null,
      { timeout: 90000 },
    );
    assert.equal(await restarted.evaluate(() => globalThis.restartedMockCalls), 2);
    assert.equal(await page.locator('#species-key').inputValue(), '');
    console.log(
      `SPECIES UI PASS; six cloud calls intercepted locally; restart and isolation verified; evidence: ${temporary}`,
    );
  } finally {
    await restarted.evaluate(({ app }) => app.exit()).catch(() => {});
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
