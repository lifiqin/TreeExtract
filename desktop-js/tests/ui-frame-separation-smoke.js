'use strict';

// 使用独立运行时和元数据副本；全景 ZIP 只读，禁止写入原始校正或用户配置。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { copyRuntime, removeTemporary } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const source = path.resolve(desktop, '..', '..', 'tree');
const executable =
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe');
const names = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = Object.fromEntries(names.map((name) => [name, hash(path.join(source, name))]));
const hasManual106 = /^\s*106\s*,/m.test(
  fs.readFileSync(path.join(source, 'manual_marks.csv'), 'utf8'),
);
const zip = path.join(source, 'Camera4.zip');
const zipBefore = fs.statSync(zip);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-frame-ui-'));
const appDir = path.join(temp, 'app');
const data = path.join(temp, 'data');
const user = path.join(temp, 'user');
fs.mkdirSync(appDir);
fs.mkdirSync(data);
fs.mkdirSync(user);
fs.cpSync(path.join(desktop, 'src'), path.join(appDir, 'src'), { recursive: true });
fs.copyFileSync(path.join(desktop, 'package.json'), path.join(appDir, 'package.json'));
copyRuntime(executable, path.join(appDir, 'runtime'));
for (const name of names) fs.copyFileSync(path.join(source, name), path.join(data, name));

async function main() {
  let application;
  try {
    application = await electron.launch({
      executablePath: require('electron'),
      args: [appDir],
      cwd: appDir,
      env: {
        ...process.env,
        TREEEXTRACT_DATA_DIR: data,
        TREEEXTRACT_ZIP: zip,
        TREEEXTRACT_TEST_HIDDEN: '1',
        TREEEXTRACT_TEST_USER_DATA: user,
      },
      timeout: 60000,
    });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => !document.querySelector('#next-tree').disabled, null, {
      timeout: 120000,
    });
    const selectTree = async (id) => {
      await page.locator(`#tree-list .tree-row[data-index="${id}"]`).click();
      await page.waitForFunction(
        (value) =>
          document.querySelector('#current-tree').textContent === String(value) &&
          !document.querySelector('#next-tree').disabled,
        id,
        { timeout: 120000 },
      );
      return page.locator('#frame-name').innerText();
    };
    const first = await selectTree(106);
    if (hasManual106)
      assert.match(await page.locator('#distance-warning').innerText(), /已有人工校正.*核查红圈/);
    const second = await selectTree(107);
    assert.notEqual(first, second, '不同树的优质近帧不能复用');
    assert.match(await page.locator('#distance-warning').innerText(), /邻树 106.*人工核查/);
    assert.equal(await page.locator('#distance-warning').isVisible(), true);
    assert.equal(await selectTree(106), first, '重新切回时主帧稳定');
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({ passed: true, frames: { 106: first, 107: second }, warning: true }),
    );
  } finally {
    if (application) await application.close();
    for (const name of names) {
      assert.equal(hash(path.join(source, name)), before[name], `原始文件不得改变: ${name}`);
      assert.equal(hash(path.join(data, name)), before[name], `隔离副本不得保存: ${name}`);
    }
    const zipAfter = fs.statSync(zip);
    assert.equal(zipAfter.size, zipBefore.size);
    assert.equal(zipAfter.mtimeMs, zipBefore.mtimeMs);
    removeTemporary(temp, 'treeextract-frame-ui-');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
