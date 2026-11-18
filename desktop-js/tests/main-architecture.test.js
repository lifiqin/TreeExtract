'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const mainFile = path.resolve(__dirname, '../src/main.js');
const mainDirectory = path.dirname(mainFile);
const requireFromMain = createRequire(mainFile);

// 执行真实的主进程装配及 IPC 模块，只替换 Electron 和进程启动。
// 不启动窗口和后端，不读取用户配置、原始数据或网络。
function startMain() {
  const handlers = new Map();
  const protocols = new Map();
  const bridgeCalls = [];
  const fetchCalls = [];
  let ready;
  let window;

  class TestWindow {
    constructor(options) {
      this.options = options;
      this.webContents = { mainFrame: {}, on() {}, setWindowOpenHandler() {} };
      window = this;
    }

    on() {}
    once() {}

    loadURL(url) {
      this.webContents.mainFrame.url = url;
    }
  }

  class TestBridge {
    async call(method) {
      bridgeCalls.push(method);
      return { loaded: false };
    }
  }

  const electron = {
    app: {
      isPackaged: false,
      whenReady: () => ({ then: (callback) => (ready = callback) }),
      on() {},
    },
    BrowserWindow: TestWindow,
    dialog: {},
    ipcMain: {
      handle(channel, handler) {
        assert.ok(!handlers.has(channel), `重复注册：${channel}`);
        handlers.set(channel, handler);
      },
    },
    protocol: {
      registerSchemesAsPrivileged() {},
      handle: (scheme, handler) => protocols.set(scheme, handler),
    },
    net: {
      fetch(url) {
        fetchCalls.push(url);
        return new Response(null, { status: 204 });
      },
    },
  };

  vm.runInNewContext(
    fs.readFileSync(mainFile, 'utf8'),
    {
      __dirname: mainDirectory,
      process: { env: {} },
      URL,
      Response,
      require(name) {
        if (name === 'electron') return electron;
        if (name === './backend') return { BridgeClient: TestBridge };
        return requireFromMain(name);
      },
    },
    { filename: mainFile },
  );
  ready();
  return { window, handlers, protocols, bridgeCalls, fetchCalls };
}

test('实际主窗口启用沙箱和上下文隔离，只使用本地预加载与界面入口', () => {
  const { window } = startMain();
  const preferences = window.options.webPreferences;
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.preload, path.join(mainDirectory, 'preload.js'));
  assert.equal(window.webContents.mainFrame.url, 'treeextract://app/index.html');
});

test('真实入口的 IPC 拒绝外部窗口、子框架和非应用页面，合法页面可调用', async () => {
  const { window, handlers, bridgeCalls } = startMain();
  const sender = window.webContents;
  const validEvent = { sender, senderFrame: sender.mainFrame };
  const invalidEvents = [
    { ...validEvent, sender: {} },
    { ...validEvent, senderFrame: { url: sender.mainFrame.url } },
  ];
  for (const [channel, handler] of handlers) {
    for (const event of invalidEvents) {
      await assert.rejects(async () => handler(event), /无效的界面请求/, channel);
    }
  }

  const pageURL = sender.mainFrame.url;
  sender.mainFrame.url = 'treeextract://app/other.html';
  for (const [channel, handler] of handlers) {
    await assert.rejects(async () => handler(validEvent), /无效的界面请求/, channel);
  }
  assert.deepEqual(bridgeCalls, []);

  sender.mainFrame.url = pageURL;
  assert.deepEqual(await handlers.get('tree:state')(validEvent), { loaded: false });
  assert.deepEqual(bridgeCalls, ['state']);
});

test('本地应用协议只读取界面文件，拒绝从 URL 访问主进程文件', async () => {
  const { protocols, fetchCalls } = startMain();
  const request = (url) => protocols.get('treeextract')({ url });
  assert.equal((await request('treeextract://other/index.html')).status, 404);
  assert.equal((await request('treeextract://app/..%2Fpreload.js')).status, 403);
  assert.deepEqual(fetchCalls, []);

  assert.equal((await request('treeextract://app/styles.css')).status, 204);
  assert.deepEqual(fetchCalls, [
    pathToFileURL(path.join(mainDirectory, 'renderer/styles.css')).href,
  ]);
});
