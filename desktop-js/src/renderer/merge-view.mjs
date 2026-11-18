export function createMergeView({ element, api, onLoad, documentRef = document }) {
  const dialog = element('merge-dialog');
  let folders = [];
  let treeDirectory = '';
  let analysis = null;
  let working = false;

  function message(text, kind = '') {
    const result = element('merge-result');
    result.textContent = text;
    result.dataset.kind = kind;
  }

  function render() {
    const list = element('merge-folders');
    list.replaceChildren();
    if (!folders.length) {
      const empty = documentRef.createElement('p');
      empty.className = 'merge-empty';
      empty.textContent = '还没有选择文件夹';
      list.append(empty);
    }
    folders.forEach((folder, index) => {
      const row = documentRef.createElement('div');
      row.className = 'merge-folder';
      const label = documentRef.createElement('span');
      label.className = 'merge-folder-path';
      label.textContent = folder;
      const remove = documentRef.createElement('button');
      remove.className = 'text-button';
      remove.textContent = '移除';
      remove.disabled = working;
      remove.setAttribute('aria-label', `移除 ${folder}`);
      remove.addEventListener('click', () => {
        folders.splice(index, 1);
        invalidate();
      });
      row.append(label, remove);
      list.append(row);
    });
    element('merge-tree-path').textContent = treeDirectory || '未选择';
    element('merge-tree-clear').hidden = !treeDirectory;
    for (const id of [
      'merge-add',
      'merge-tree-choose',
      'merge-tree-clear',
      'merge-close',
      'merge-cancel',
    ])
      element(id).disabled = working;
    element('merge-analyze').disabled = working || folders.length < 2;
    element('merge-run').disabled = working || !analysis?.ok;
  }

  function invalidate() {
    analysis = null;
    message('文件夹已更新，请重新分析。');
    render();
  }

  function report(result) {
    const target = element('merge-result');
    target.replaceChildren();
    target.dataset.kind = result.ok ? 'success' : 'error';
    const heading = documentRef.createElement('strong');
    heading.textContent = result.ok
      ? `格式检查通过：${result.imageCount} 张全景，${result.metaCount} 条完整位姿${result.treeCount ? `，${result.treeCount} 棵树` : ''}。`
      : '暂时不能合并，请处理以下问题：';
    target.append(heading);
    const notes = [...result.errors, ...result.warnings];
    if (notes.length) {
      const list = documentRef.createElement('ul');
      for (const note of notes) {
        const item = documentRef.createElement('li');
        item.textContent = note;
        list.append(item);
      }
      target.append(list);
    }
  }

  async function runTask(text, fallbackError, action) {
    working = true;
    render();
    message(text);
    try {
      await action();
    } catch (error) {
      // 失败后必须重新分析，不能让旧的通过结果继续启用合并按钮。
      analysis = null;
      message(error.message || fallbackError, 'error');
    } finally {
      working = false;
      render();
    }
  }

  function bind() {
    element('open-merge').addEventListener('click', () => {
      render();
      dialog.showModal();
    });
    const close = () => {
      if (!working) dialog.close();
    };
    element('merge-close').addEventListener('click', close);
    element('merge-cancel').addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => {
      if (working) event.preventDefault();
    });
    element('merge-add').addEventListener('click', async () => {
      try {
        const selected = await api.chooseMergeFolders();
        for (const item of selected || [])
          if (!folders.some((f) => f.toLowerCase() === item.toLowerCase())) folders.push(item);
        if (selected?.length) invalidate();
      } catch (error) {
        message(error.message, 'error');
      }
    });
    element('merge-tree-choose').addEventListener('click', async () => {
      try {
        const chosen = await api.chooseMergeTrees();
        if (chosen) {
          treeDirectory = chosen;
          invalidate();
        }
      } catch (error) {
        message(error.message, 'error');
      }
    });
    element('merge-tree-clear').addEventListener('click', () => {
      treeDirectory = '';
      invalidate();
    });
    element('merge-analyze').addEventListener('click', () => {
      analysis = null;
      return runTask('正在检查照片、位姿和坐标参数，请稍候…', '分析失败。', async () => {
        const result = await api.analyzeMerge(folders, treeDirectory);
        report(result);
        analysis = result;
      });
    });
    element('merge-run').addEventListener('click', () =>
      runTask(
        '正在选择保存位置；开始后将打包全景照片，可能需要几分钟…',
        '合并失败，请重新分析。',
        async () => {
          const result = await api.executeMerge();
          if (!result) {
            report(analysis);
            return;
          }
          analysis = null;
          message(
            `合并完成：${result.directory}${result.loadable ? '。正在加载…' : '。未选择树心数据，暂不能加载树列表。'}`,
            'success',
          );
          if (result.loadable) {
            const loaded = await onLoad(result.directory);
            message(
              `合并完成：${result.directory}${loaded ? '。已在软件中加载。' : '。自动加载未完成，请检查当前会话提示后手动选择该目录。'}`,
              loaded ? 'success' : 'error',
            );
          }
        },
      ),
    );
  }
  return { bind };
}
