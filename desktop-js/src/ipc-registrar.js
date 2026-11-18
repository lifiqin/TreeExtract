'use strict';

// 所有主进程 IPC 必须经过同一个调用来源检查。
function createIpcRegistrar(ipcMain, authorize) {
  const channels = new Set();
  return (channel, handler) => {
    if (channels.has(channel)) throw new Error(`重复注册 IPC：${channel}`);
    channels.add(channel);
    ipcMain.handle(channel, (event, ...args) => {
      authorize(event);
      return handler(...args);
    });
  };
}

module.exports = { createIpcRegistrar };
