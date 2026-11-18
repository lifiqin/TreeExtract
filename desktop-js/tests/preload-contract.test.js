'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 独立维护预加载 API 契约；不能由生产映射生成，否则错误会同时进入预期值。
const contracts = [
  ['defaults', 'tree:defaults'],
  ['load', 'tree:load', ['data', 'images.zip'], [{ dataDir: 'data', zipPath: 'images.zip' }]],
  ['state', 'tree:state'],
  ['trees', 'tree:trees'],
  ['images', 'tree:images'],
  ['panoramaImage', 'tree:panorama-image', [true], [{ preview: true }]],
  ['selectTree', 'tree:tree-select', [12], [{ index: 12 }]],
  ['nearestTree', 'tree:tree-nearest'],
  ['stepFrame', 'tree:frame-step', [-1], [{ direction: -1 }]],
  [
    'setOptions',
    'tree:view-options',
    [{ frameStrategy: 'nearest' }],
    [{ frameStrategy: 'nearest' }],
  ],
  ['pan', 'tree:view-pan', [0.2, -0.1, 60], [{ panDelta: 0.2, tiltDelta: -0.1, fov: 60 }]],
  ['setMark', 'tree:mark-set', [0.3, 0.7], [{ x: 0.3, y: 0.7 }]],
  ['setPanoMark', 'tree:mark-set-pano', [0.4, 0.6], [{ x: 0.4, y: 0.6 }]],
  ['resetMark', 'tree:mark-reset'],
  ['saveMark', 'tree:mark-save'],
  ['recognize', 'tree:recognize'],
  ['speciesCatalog', 'species:catalog'],
  ['speciesContext', 'species:context'],
  ['speciesCredentialStatus', 'species:credential-status'],
  ['speciesCredentialSave', 'species:credential-save', ['test-key'], ['test-key']],
  ['speciesCredentialClear', 'species:credential-clear'],
  ['speciesPreview', 'species:preview', [{ treeId: 12 }], [{ treeId: 12 }]],
  ['speciesCancelPreview', 'species:cancel-preview'],
  [
    'speciesAnalyze',
    'species:analyze',
    [true, { treeId: 12 }],
    [{ reviewConfirmed: true, scope: { treeId: 12 } }],
  ],
  ['speciesSave', 'species:save', [{ categoryId: 'test' }], [{ categoryId: 'test' }]],
  ['buildTable', 'tree:table-build'],
  ['selectTableRow', 'tree:table-select', [42], [{ id: 42 }]],
  ['exportTable', 'tree:export-table', ['xlsx'], ['xlsx']],
  ['chooseData', 'tree:choose-data'],
  ['chooseZip', 'tree:choose-zip'],
  ['chooseMergeFolders', 'merge:choose-folders'],
  ['chooseMergeTrees', 'merge:choose-trees'],
  [
    'analyzeMerge',
    'merge:analyze',
    [['one', 'two'], 'trees'],
    [{ folders: ['one', 'two'], treeDirectory: 'trees' }],
  ],
  ['executeMerge', 'merge:execute'],
  ['saveCrop', 'tree:save-crop'],
];

function loadPreload(invoke) {
  let api;
  let exposureCount = 0;
  const source = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron', '沙箱预加载不得引入文件系统或其他模块');
      return {
        ipcRenderer: { invoke },
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'treeApp');
            exposureCount++;
            api = value;
          },
        },
      };
    },
  });
  assert.equal(exposureCount, 1);
  return api;
}

test('预加载只暴露固定操作，逐项保留 IPC 通道、参数和异步返回值', async () => {
  const calls = [];
  const result = { sentinel: true };
  const api = loadPreload((...args) => {
    calls.push(structuredClone(args));
    return Promise.resolve(result);
  });
  assert.deepEqual(Object.keys(api).sort(), contracts.map(([name]) => name).sort());
  for (const [name, channel, input = [], parameters = []] of contracts) {
    assert.equal(typeof api[name], 'function');
    assert.equal(await api[name](...input), result, name);
    assert.deepEqual(calls.pop(), [channel, ...parameters], name);
    assert.equal(calls.length, 0, `${name} 不应附加额外调用`);
  }
  await api.panoramaImage();
  assert.deepEqual(calls.pop(), ['tree:panorama-image', { preview: false }]);
});

test('预加载不吞掉后端拒绝，也不自动重试写入或上传', async () => {
  const error = new Error('test rejection');
  let calls = 0;
  const api = loadPreload(() => {
    calls++;
    return Promise.reject(error);
  });
  for (const [name, , input = []] of contracts) {
    await assert.rejects(api[name](...input), (actual) => actual === error);
  }
  assert.equal(calls, contracts.length);
});
