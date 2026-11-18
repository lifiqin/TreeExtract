'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 只向页面提供应用操作，不暴露 Node、文件系统或原始 IPC 接口。
contextBridge.exposeInMainWorld('treeApp', {
  defaults: () => ipcRenderer.invoke('tree:defaults'),
  load: (dataDir, zipPath) => ipcRenderer.invoke('tree:load', { dataDir, zipPath }),
  state: () => ipcRenderer.invoke('tree:state'),
  trees: () => ipcRenderer.invoke('tree:trees'),
  images: () => ipcRenderer.invoke('tree:images'),
  panoramaImage: (preview = false) => ipcRenderer.invoke('tree:panorama-image', { preview }),
  selectTree: (index) => ipcRenderer.invoke('tree:tree-select', { index }),
  nearestTree: () => ipcRenderer.invoke('tree:tree-nearest'),
  stepFrame: (direction) => ipcRenderer.invoke('tree:frame-step', { direction }),
  setOptions: (options) => ipcRenderer.invoke('tree:view-options', options),
  pan: (panDelta, tiltDelta, fov) =>
    ipcRenderer.invoke('tree:view-pan', { panDelta, tiltDelta, fov }),
  setMark: (x, y) => ipcRenderer.invoke('tree:mark-set', { x, y }),
  setPanoMark: (x, y) => ipcRenderer.invoke('tree:mark-set-pano', { x, y }),
  resetMark: () => ipcRenderer.invoke('tree:mark-reset'),
  saveMark: () => ipcRenderer.invoke('tree:mark-save'),
  recognize: () => ipcRenderer.invoke('tree:recognize'),
  speciesCatalog: () => ipcRenderer.invoke('species:catalog'),
  speciesContext: () => ipcRenderer.invoke('species:context'),
  speciesCredentialStatus: () => ipcRenderer.invoke('species:credential-status'),
  speciesCredentialSave: (key) => ipcRenderer.invoke('species:credential-save', key),
  speciesCredentialClear: () => ipcRenderer.invoke('species:credential-clear'),
  speciesPreview: (scope) => ipcRenderer.invoke('species:preview', scope),
  speciesCancelPreview: () => ipcRenderer.invoke('species:cancel-preview'),
  speciesAnalyze: (reviewConfirmed, scope) =>
    ipcRenderer.invoke('species:analyze', { reviewConfirmed, scope }),
  speciesSave: (selection) => ipcRenderer.invoke('species:save', selection),
  buildTable: () => ipcRenderer.invoke('tree:table-build'),
  selectTableRow: (id) => ipcRenderer.invoke('tree:table-select', { id }),
  exportTable: (format) => ipcRenderer.invoke('tree:export-table', format),
  chooseData: () => ipcRenderer.invoke('tree:choose-data'),
  chooseZip: () => ipcRenderer.invoke('tree:choose-zip'),
  chooseMergeFolders: () => ipcRenderer.invoke('merge:choose-folders'),
  chooseMergeTrees: () => ipcRenderer.invoke('merge:choose-trees'),
  analyzeMerge: (folders, treeDirectory) =>
    ipcRenderer.invoke('merge:analyze', { folders, treeDirectory }),
  executeMerge: () => ipcRenderer.invoke('merge:execute'),
  saveCrop: () => ipcRenderer.invoke('tree:save-crop'),
});
