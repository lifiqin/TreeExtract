'use strict';

const { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BridgeClient } = require('./backend');
const { CloudCredentialStore } = require('./cloud-credentials');
const { SessionCoordinator } = require('./session-coordinator');
const { createIpcRegistrar } = require('./ipc-registrar');
const { registerTreeIpc } = require('./tree-ipc');
const { registerSpeciesIpc } = require('./species-ipc');
const { registerMergeIpc } = require('./merge-ipc');

// 隐藏模式测试使用独立用户目录，绝不读取真实账户的密钥或确认记录。
if (process.env.TREEEXTRACT_TEST_HIDDEN === '1' && process.env.TREEEXTRACT_TEST_USER_DATA)
  app.setPath('userData', path.resolve(process.env.TREEEXTRACT_TEST_USER_DATA));

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'treeextract',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const rendererDirectory = path.join(__dirname, 'renderer');
let windowHandle;
let bridge;
let closeApproved = false;
let mergeInProgress = false;

function registerLocalProtocol() {
  protocol.handle('treeextract', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    let requested;
    try {
      requested = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad path', { status: 400 });
    }
    const file = path.resolve(rendererDirectory, `.${requested}`);
    const relative = path.relative(rendererDirectory, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function requireWindow(event) {
  if (
    !windowHandle ||
    event.sender !== windowHandle.webContents ||
    event.senderFrame !== windowHandle.webContents.mainFrame ||
    event.senderFrame.url !== 'treeextract://app/index.html'
  )
    throw new Error('无效的界面请求。');
}

async function confirmClose(event) {
  if (closeApproved) return;
  event.preventDefault();
  if (mergeInProgress) {
    await dialog.showMessageBox(windowHandle, {
      type: 'info',
      title: '正在合并数据',
      message: '请等待合并完成后再关闭软件。',
      buttons: ['知道了'],
    });
    return;
  }
  try {
    const state = await bridge.call('state', {}, 15000);
    if (state.markDirty) {
      const choice = await dialog.showMessageBox(windowHandle, {
        type: 'warning',
        title: '尚有未保存的校正',
        message: '当前有未保存的红圈校正，关闭前需要保存吗？',
        buttons: ['保存并关闭', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2,
      });
      if (choice.response === 2) return;
      if (choice.response === 0) await bridge.call('mark.save');
    }
  } catch (error) {
    const choice = await dialog.showMessageBox(windowHandle, {
      type: 'warning',
      title: '无法确认保存状态',
      message: error.message,
      detail: '继续关闭可能丢失尚未保存的校正。',
      buttons: ['取消', '仍然关闭'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response !== 1) return;
  }
  closeApproved = true;
  windowHandle.close();
}

function createWindow() {
  windowHandle = new BrowserWindow({
    width: 1540,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#101917',
    title: 'TreeExtract · 单木工作台',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowHandle.once('ready-to-show', () => {
    if (process.env.TREEEXTRACT_TEST_HIDDEN === '1') {
      windowHandle.setPosition(-10000, -10000);
      windowHandle.showInactive();
    } else {
      windowHandle.show();
    }
  });
  windowHandle.on('close', confirmClose);
  windowHandle.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowHandle.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('treeextract://app/')) event.preventDefault();
  });
  windowHandle.loadURL('treeextract://app/index.html');
}

app.whenReady().then(() => {
  registerLocalProtocol();
  // 打包后桥接程序位于 resources/runtime，而开发模式直接使用项目里的 runtime。
  const runtimeDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.join(__dirname, '..', 'runtime');
  const executable = path.join(runtimeDirectory, 'TreeExtractorBridge.exe');
  bridge = new BridgeClient(executable);
  const coordinator = new SessionCoordinator();
  const shared = {
    handle: createIpcRegistrar(ipcMain, requireWindow),
    bridge,
    coordinator,
    dialog,
    getWindow: () => windowHandle,
  };
  registerTreeIpc({ ...shared, environment: process.env });
  registerMergeIpc({
    ...shared,
    onBusyChange: (value) => {
      mergeInProgress = value;
    },
    writeArchive: async (output, images) => {
      const archiveBridge = new BridgeClient(executable);
      try {
        return await archiveBridge.call('merge.archive', { output, images }, 4 * 60 * 60 * 1000);
      } finally {
        archiveBridge.close();
      }
    },
  });
  registerSpeciesIpc({
    ...shared,
    getSpeciesDirectory: () => path.join(app.getPath('userData'), 'species-confirmations'),
    getCredentials: () =>
      new CloudCredentialStore(
        path.join(app.getPath('userData'), 'cloud-credentials'),
        safeStorage,
      ),
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (bridge) bridge.close();
  app.quit();
});
