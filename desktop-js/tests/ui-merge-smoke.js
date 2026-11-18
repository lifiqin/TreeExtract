'use strict';

// 在隔离副本中实际操作界面和后台，照片由浏览器生成，不读取真实数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { copyRuntime, removeTemporary } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-ui-merge-'));
const isolated = path.join(temp, 'app');
const user = path.join(temp, 'user');
fs.mkdirSync(isolated);
fs.mkdirSync(user);
fs.cpSync(path.join(desktop, 'src'), path.join(isolated, 'src'), { recursive: true });
fs.copyFileSync(path.join(desktop, 'package.json'), path.join(isolated, 'package.json'));
copyRuntime(
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe'),
  path.join(isolated, 'runtime'),
);
const defaultData = path.join(temp, 'default');
fs.mkdirSync(defaultData);
const fixtures = [100, 200].map((time, index) => {
  const target = path.join(temp, `capture-${index}`);
  const targetPic = path.join(target, 'Camera4', 'Picture');
  fs.mkdirSync(path.join(targetPic, 'PictureData'), { recursive: true });
  fs.writeFileSync(
    path.join(targetPic, 'Metashape.txt'),
    `imageName X Y Z Omega Phi Kappa\n${time}.1.jpg ${10 + index * 4} 20 10 0 0 0\n`,
  );
  fs.writeFileSync(path.join(targetPic, 'Camera4Param.txt'), 'synthetic camera');
  fs.writeFileSync(path.join(target, 'PointCloud.crd'), 'synthetic coordinate system');
  fs.writeFileSync(path.join(target, 'Block_1.xml'), '<x><Definition>synthetic</Definition></x>');
  fs.writeFileSync(
    path.join(target, 'imgPosList.txt'),
    `ImageName GPSTime Longitude Latitude H_Ell Roll Pitch Heading\n${time}.1 ${time}.1 120 30 10 0 0 0\n${time}.2 ${time}.2 120 30 10 0 0 0\n`,
  );
  return target;
});
const trees = path.join(temp, 'trees');
fs.mkdirSync(trees);
fs.writeFileSync(
  path.join(trees, 'tree_centers2.txt'),
  'ID X Y Z Height Species\n1 12 24 8 8 test\n',
);
const resultParent = path.join(temp, 'results');
fs.mkdirSync(resultParent);

async function main() {
  const application = await electron.launch({
    executablePath: require('electron'),
    args: [isolated],
    cwd: isolated,
    env: {
      ...process.env,
      TREEEXTRACT_DATA_DIR: defaultData,
      TREEEXTRACT_ZIP: '',
      TREEEXTRACT_TEST_HIDDEN: '1',
      TREEEXTRACT_TEST_USER_DATA: user,
    },
    timeout: 60000,
  });
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(
      () =>
        !document.querySelector('#open-merge').disabled &&
        document.querySelector('#connection-label').textContent === '需要处理',
      null,
      { timeout: 90000 },
    );
    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 5760;
      canvas.height = 2880;
      const context = canvas.getContext('2d');
      context.fillStyle = '#6d9b72';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#475b43';
      context.fillRect(2750, 500, 260, 2000);
      return canvas.toDataURL('image/jpeg', 0.65).split(',')[1];
    });
    for (let i = 0; i < fixtures.length; i++)
      fs.writeFileSync(
        path.join(fixtures[i], 'Camera4', 'Picture', 'PictureData', `${i ? 200 : 100}.1.jpg`),
        Buffer.from(jpeg, 'base64'),
      );
    await application.evaluate(
      ({ dialog }, values) => {
        const queue = [
          { canceled: false, filePaths: values.invalid },
          { canceled: false, filePaths: values.fixtures },
          { canceled: false, filePaths: [values.trees] },
          { canceled: false, filePaths: [values.output] },
        ];
        globalThis.mergeDialogs = [];
        dialog.showOpenDialog = async () => queue.shift();
        dialog.showMessageBox = async (_, options) => {
          globalThis.mergeDialogs.push(options);
          return { response: 0 };
        };
      },
      {
        invalid: [path.join(temp, 'missing-a'), path.join(temp, 'missing-b')],
        fixtures,
        trees,
        output: resultParent,
      },
    );
    await page.locator('#open-merge').click();
    await page.locator('#merge-add').click();
    await page.locator('#merge-analyze').click();
    await page.waitForFunction(
      () => document.querySelector('#merge-result').dataset.kind === 'error',
    );
    assert.equal(
      await application.evaluate(() => globalThis.mergeDialogs.length),
      1,
      '不兼容必须弹窗',
    );
    assert.equal(await page.locator('#merge-run').isDisabled(), true);
    await page.locator('#merge-folders button').first().click();
    await page.locator('#merge-folders button').first().click();
    await page.locator('#merge-add').click();
    await page.locator('#merge-tree-choose').click();
    await page.locator('#merge-analyze').click();
    await page.waitForFunction(
      () => document.querySelector('#merge-result').dataset.kind === 'success',
      null,
      { timeout: 60000 },
    );
    assert.match(await page.locator('#merge-result').innerText(), /2 张全景/);
    const artifacts = path.join(desktop, 'test-artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    const screenshot = path.join(artifacts, `merge-dialog-${Date.now()}.png`);
    await page.screenshot({ path: screenshot });
    await page.locator('#merge-run').click();
    await page.waitForFunction(
      () => document.querySelector('#merge-result').textContent.includes('已在软件中加载'),
      null,
      { timeout: 120000 },
    );
    assert.equal(await page.locator('#summary-trees').innerText(), '1');
    assert.equal(await page.locator('#summary-frames').innerText(), '2');
    assert.ok(await page.locator('#pano-image').evaluate((image) => image.naturalWidth > 0));
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ passed: true, screenshot, trees: 1, frames: 2 }));
  } finally {
    await application.close();
    removeTemporary(temp, 'treeextract-ui-merge-');
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
