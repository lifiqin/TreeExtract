'use strict';

// 页面只可调用明确列出的桥接方法；测试快照等内部接口不暴露给页面。
const TREE_BRIDGE_METHODS = Object.freeze({
  defaults: 'defaults',
  load: 'load',
  state: 'state',
  trees: 'trees',
  images: 'images',
  'panorama-image': 'panorama.image',
  'tree-select': 'tree.select',
  'tree-nearest': 'tree.nearest',
  'frame-step': 'frame.step',
  'view-options': 'view.options',
  'view-pan': 'view.pan',
  'mark-set': 'mark.set',
  'mark-set-pano': 'mark.setPano',
  'mark-reset': 'mark.reset',
  'mark-save': 'mark.save',
  recognize: 'recognize',
  'table-build': 'table.build',
  'table-select': 'table.select',
});

function cropWarning(inspection) {
  if (inspection.status !== 'complete') return '人体及头部检测不可用，不能判断切图是否包含人员。';
  if (inspection.headDetected || inspection.personDetected)
    return '本地模型在切图中发现疑似人体或头部。';
  return '本地模型未检出人体或头部，但仍可能漏检。';
}

function registerTreeIpc({ handle, bridge, coordinator, dialog, getWindow, environment }) {
  for (const [channel, method] of Object.entries(TREE_BRIDGE_METHODS)) {
    handle(`tree:${channel}`, async (parameters) => {
      coordinator.beforeBackendCall(method);
      const session = environment.TREEEXTRACT_DATA_DIR;
      const zip = environment.TREEEXTRACT_ZIP;
      if (method === 'defaults' && session) {
        const defaults = await bridge.call(method, {});
        return { ...defaults, dataDir: session, zipPath: zip || '' };
      }
      const args = parameters || {};
      if (method === 'load' && session && !args.dataDir && !args.zipPath)
        return bridge.call(method, { dataDir: session, zipPath: zip || '' });
      return bridge.call(method, args);
    });
  }

  handle('tree:choose-data', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择数据目录',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('tree:choose-zip', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择全景图 ZIP',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 全景包', extensions: ['zip'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('tree:save-crop', async () => {
    const result = await dialog.showSaveDialog(getWindow(), {
      title: '保存单木切图',
      defaultPath: 'tree-crop.png',
      filters: [{ name: 'PNG 图像', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const inspection = await bridge.call('crop.inspect');
    const choice = await dialog.showMessageBox(getWindow(), {
      type: 'warning',
      title: '保存前人工核查',
      message: cropWarning(inspection),
      detail: '模型不能确认是否存在头皮。请先核对当前切图；如未核查，请取消并换帧。',
      buttons: ['取消', '已人工核查，保存'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response !== 1) return null;
    return bridge.call('crop.save', {
      path: result.filePath,
      imageSha256: inspection.imageSha256,
      reviewConfirmed: true,
    });
  });

  handle('tree:export-table', async (format) => {
    if (!['csv', 'xlsx'].includes(format)) throw new Error('不支持的导出格式。');
    const result = await dialog.showSaveDialog(getWindow(), {
      title: '导出树心与全景对照表',
      defaultPath: `tree-frames.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (result.canceled || !result.filePath) return null;
    return bridge.call('table.export', { path: result.filePath, format });
  });
}

module.exports = { TREE_BRIDGE_METHODS, cropWarning, registerTreeIpc };
