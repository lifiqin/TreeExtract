'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIpcRegistrar } = require('../src/ipc-registrar');
const { SessionCoordinator } = require('../src/session-coordinator');
const { TREE_BRIDGE_METHODS, registerTreeIpc } = require('../src/tree-ipc');
const { registerSpeciesIpc } = require('../src/species-ipc');
const { registerMergeIpc } = require('../src/merge-ipc');
const { scopeOf } = require('../src/species-scope');

function snapshot(overrides = {}) {
  return {
    dataDir: path.resolve('ipc-test-data'),
    datasetFingerprint: 'a'.repeat(64),
    treeId: 92,
    treeIndex: 92,
    frame: 'frame.jpg',
    imageSha256: 'b'.repeat(64),
    image: 'test-image',
    peopleDetection: { status: 'complete', personDetected: false, headDetected: false },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(overrides = {}) {
  const registered = new Map();
  const calls = [];
  const validEvent = {};
  const ipcMain = {
    handle(channel, handler) {
      assert.equal(registered.has(channel), false, `duplicate channel ${channel}`);
      registered.set(channel, handler);
    },
  };
  const handle = createIpcRegistrar(ipcMain, (event) => {
    if (event !== validEvent) throw new Error('unauthorized');
  });
  const coordinator = new SessionCoordinator();
  const bridge = {
    async call(method, args) {
      calls.push({ method, args });
      if (overrides.bridgeCall) return overrides.bridgeCall(method, args);
      if (method === 'recognition.snapshot') return snapshot();
      if (method === 'recognize') return { text: 'local' };
      if (method === 'crop.inspect') return { status: 'complete', imageSha256: 'digest' };
      return { method, args };
    },
  };
  const dialog = {
    showMessageBox: overrides.showMessageBox || (async () => ({ response: 0 })),
    showOpenDialog: async () => ({ canceled: true }),
    showSaveDialog: overrides.showSaveDialog || (async () => ({ canceled: true })),
  };
  const credentials = overrides.credentials || {
    status: async () => ({ configured: true }),
    save: async () => ({ configured: true }),
    clear: async () => ({ configured: false }),
    read: async () => 'placeholder',
  };
  const store = overrides.store || {
    readSpecies: async () => null,
    validateSelection: () => ({ name: 'test' }),
    recordRevision: () => null,
    saveSpecies: async () => ({ saved: true }),
  };
  const cloud = overrides.cloud || {
    catalog: [],
    MODEL: 'mock',
    analyzeVisual: async () => ({ reason: 'visual' }),
    synthesizeSpecies: async () => ({ opinion: 'combined' }),
  };
  const shared = { handle, bridge, coordinator, dialog, getWindow: () => ({}) };
  registerTreeIpc({ ...shared, environment: overrides.environment || {} });
  registerMergeIpc({ ...shared, writeArchive: async () => {} });
  registerSpeciesIpc({
    ...shared,
    getSpeciesDirectory: () => 'isolated-records',
    getCredentials: () => credentials,
    store,
    cloud,
  });
  const invoke = async (channel, ...args) => registered.get(channel)(validEvent, ...args);
  return { registered, calls, coordinator, invoke };
}

test('所有 IPC 均验证来源，预加载白名单与注册通道一致', async () => {
  const h = harness();
  for (const handler of h.registered.values())
    await assert.rejects(async () => handler({}), /unauthorized/);
  assert.equal(h.calls.length, 0);
  const source = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  const exposed = [...source.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(exposed)].sort(), [...h.registered.keys()].sort());
});

test('公开的树木桥接方法均存在于后端分发表，内部快照不直接暴露', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../bridge/BackendSession.DesktopBridge.cs'),
    'utf8',
  );
  const cases = new Set([...source.matchAll(/case "([^"]+)"/g)].map((m) => m[1]));
  for (const method of Object.values(TREE_BRIDGE_METHODS)) assert.ok(cases.has(method), method);
  for (const method of ['crop.inspect', 'crop.save', 'table.export', 'recognition.snapshot'])
    assert.ok(cases.has(method), method);
  assert.equal(Object.values(TREE_BRIDGE_METHODS).includes('recognition.snapshot'), false);
});

test('测试数据默认路径只注入空加载参数，显式选择不被覆盖', async () => {
  const h = harness({
    environment: { TREEEXTRACT_DATA_DIR: 'data', TREEEXTRACT_ZIP: 'images.zip' },
  });
  assert.equal((await h.invoke('tree:defaults')).dataDir, 'data');
  await h.invoke('tree:load', {});
  await h.invoke('tree:load', { dataDir: 'chosen' });
  assert.deepEqual(h.calls[1].args, { dataDir: 'data', zipPath: 'images.zip' });
  assert.deepEqual(h.calls[2].args, { dataDir: 'chosen' });
});

test('不能合并时显示原因弹窗，未通过分析不能执行', async () => {
  const dialogs = [];
  const h = harness({
    showMessageBox: async (_, options) => {
      dialogs.push(options);
      return { response: 0 };
    },
  });
  const result = await h.invoke('merge:analyze', { folders: [] });
  assert.equal(result.ok, false);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].title, /无法合并/);
  assert.match(dialogs[0].detail, /2 至 16/);
  await assert.rejects(h.invoke('merge:execute'), /先选择/);
});

test('预览完成前切换树木或取消，会拒绝迟到的旧快照', async () => {
  for (const invalidate of ['tree:tree-select', 'species:cancel-preview']) {
    const pending = deferred();
    const h = harness({
      bridgeCall: (method) =>
        method === 'recognition.snapshot' ? pending.promise : { loaded: true },
    });
    const preview = h.invoke('species:preview', scopeOf(snapshot()));
    await h.invoke(invalidate, { index: 93 });
    pending.resolve(snapshot());
    await assert.rejects(preview, /重新核查/);
    assert.equal(h.coordinator.previewScope, null);
  }
});

test('未勾选或取消上传不会读取密钥、发起云端请求，预览不能复用', async () => {
  let reads = 0;
  let uploads = 0;
  const h = harness({
    credentials: {
      read: async () => {
        reads += 1;
        return 'placeholder';
      },
    },
    cloud: {
      catalog: [],
      analyzeVisual: async () => {
        uploads += 1;
      },
    },
  });
  const scope = scopeOf(snapshot());
  await assert.rejects(h.invoke('species:analyze', { reviewConfirmed: false, scope }), /人工核查/);
  await h.invoke('species:preview', scope);
  assert.deepEqual(await h.invoke('species:analyze', { reviewConfirmed: true, scope }), {
    cancelled: true,
  });
  await assert.rejects(h.invoke('species:analyze', { reviewConfirmed: true, scope }), /重新预览/);
  assert.equal(reads, 0);
  assert.equal(uploads, 0);
});

test('人工确认期间阻止修改会话和密钥，允许读取状态；取消后解除锁定', async () => {
  const waiting = deferred();
  const shown = deferred();
  const h = harness({
    showMessageBox: () => {
      shown.resolve();
      return waiting.promise;
    },
  });
  const scope = scopeOf(snapshot());
  await h.invoke('species:preview', scope);
  const analysis = h.invoke('species:analyze', { reviewConfirmed: true, scope });
  await shown.promise;
  await assert.rejects(h.invoke('tree:tree-select', { index: 1 }), /等待/);
  await assert.rejects(h.invoke('tree:mark-save'), /等待/);
  await assert.rejects(h.invoke('species:credential-save', 'placeholder'), /稍候/);
  await h.invoke('tree:state');
  await h.invoke('tree:images');
  waiting.resolve({ response: 0 });
  assert.deepEqual(await analysis, { cancelled: true });
  await h.invoke('tree:tree-select', { index: 1 });
});

test('密钥更新与识别互斥，写入失败后会解除锁定', async () => {
  const waiting = deferred();
  const h = harness({
    credentials: {
      save: async () => {
        await waiting.promise;
        throw new Error('storage failed');
      },
    },
  });
  const saving = h.invoke('species:credential-save', 'placeholder');
  await assert.rejects(
    h.invoke('species:analyze', { reviewConfirmed: true, scope: scopeOf(snapshot()) }),
    /正在进行/,
  );
  await assert.rejects(h.invoke('tree:tree-select', { index: 1 }), /等待/);
  waiting.resolve();
  await assert.rejects(saving, /storage failed/);
  await h.invoke('tree:tree-select', { index: 1 });
});

test('确认前后切图不一致时不读取密钥或调用云端', async () => {
  let snapshotCount = 0;
  let reads = 0;
  const h = harness({
    bridgeCall: (method) => {
      if (method !== 'recognition.snapshot') return {};
      snapshotCount += 1;
      return snapshotCount === 3 ? snapshot({ frame: 'different.jpg' }) : snapshot();
    },
    credentials: {
      read: async () => {
        reads += 1;
        return 'placeholder';
      },
    },
    showMessageBox: async () => ({ response: 1 }),
  });
  const scope = scopeOf(snapshot());
  await h.invoke('species:preview', scope);
  await assert.rejects(h.invoke('species:analyze', { reviewConfirmed: true, scope }), /切图已变化/);
  assert.equal(reads, 0);
  await h.invoke('tree:tree-select', { index: 1 });
});

test('确认后使用同一切图运行本地与云端，且最终清除授权', async () => {
  const seen = [];
  const h = harness({
    showMessageBox: async () => ({ response: 1 }),
    cloud: {
      catalog: [],
      MODEL: 'mock',
      analyzeVisual: async ({ image }) => {
        seen.push(image);
        return { reason: 'visual' };
      },
      synthesizeSpecies: async ({ localText }) => ({ opinion: localText }),
    },
  });
  const scope = scopeOf(snapshot());
  await h.invoke('species:preview', scope);
  const result = await h.invoke('species:analyze', { reviewConfirmed: true, scope });
  assert.deepEqual(seen, ['test-image']);
  assert.equal(result.localCompleted, true);
  assert.equal(result.synthesis.opinion, 'local');
  assert.equal(h.coordinator.previewScope, null);
  await assert.rejects(h.invoke('species:analyze', { reviewConfirmed: true, scope }), /重新预览/);
});

test('切图导出必须经人工确认，保存时绑定检查过的摘要', async () => {
  let response = 0;
  const h = harness({
    showSaveDialog: async () => ({ filePath: 'isolated.png' }),
    showMessageBox: async () => ({ response }),
  });
  assert.equal(await h.invoke('tree:save-crop'), null);
  assert.equal(
    h.calls.some((call) => call.method === 'crop.save'),
    false,
  );
  response = 1;
  await h.invoke('tree:save-crop');
  const save = h.calls.find((call) => call.method === 'crop.save');
  assert.deepEqual(save.args, {
    path: 'isolated.png',
    imageSha256: 'digest',
    reviewConfirmed: true,
  });
});
