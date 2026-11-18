'use strict';

const { analyzeFolders, createMergedDataset, publicAnalysis } = require('./dataset-merge');

function registerMergeIpc({ handle, dialog, getWindow, writeArchive, onBusyChange = () => {} }) {
  let analysis = null;
  let active = false;

  handle('merge:choose-folders', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择要合并的原始采集文件夹（可多选）',
      properties: ['openDirectory', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle('merge:choose-trees', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择已有树心文件的数据目录',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('merge:analyze', async ({ folders, treeDirectory } = {}) => {
    if (active) throw new Error('分析或合并正在进行，请稍候。');
    active = true;
    analysis = null;
    try {
      const result = await analyzeFolders(folders, treeDirectory);
      if (result.ok) analysis = result;
      else
        await dialog.showMessageBox(getWindow(), {
          type: 'warning',
          title: '暂时无法合并',
          message: '检查发现无法安全合并的数据。',
          detail: result.errors.slice(0, 12).join('\n'),
          buttons: ['知道了'],
          noLink: true,
        });
      return publicAnalysis(result);
    } finally {
      active = false;
    }
  });

  handle('merge:execute', async () => {
    if (active) throw new Error('分析或合并正在进行，请稍候。');
    if (!analysis) throw new Error('请先选择采集文件夹并通过兼容性分析。');
    active = true;
    try {
      const selected = await dialog.showOpenDialog(getWindow(), {
        title: '选择合并结果的保存位置',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (selected.canceled || !selected.filePaths[0]) return null;
      onBusyChange(true);
      try {
        return await createMergedDataset(analysis, selected.filePaths[0], writeArchive);
      } catch (error) {
        analysis = null;
        await dialog.showMessageBox(getWindow(), {
          type: 'error',
          title: '合并未完成',
          message: '没有覆盖原始文件。',
          detail: error.message,
          buttons: ['知道了'],
          noLink: true,
        });
        throw error;
      } finally {
        onBusyChange(false);
      }
    } finally {
      active = false;
    }
  });
}

module.exports = { registerMergeIpc };
