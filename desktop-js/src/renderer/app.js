import { setupPhotoInteraction, setupPanoramaInteraction } from './image-interactions.js';
import { renderDualFrameInfo } from './dual-frame-view.mjs';
import { renderPhotoMetadata } from './photo-metadata-view.mjs';
import { ImageSafetyGate } from './image-safety-gate.mjs';
import { createSpeciesReview } from './species-review.mjs';
import { createTreeListView } from './tree-list-view.mjs';
import { setupImageFocus } from './image-focus.mjs';
import { createTableView } from './table-view.mjs';
import { createMergeView } from './merge-view.mjs';

const api = window.treeApp;
const element = (id) => document.getElementById(id);
const imageSafetyGates = { photo: new ImageSafetyGate(), crop: new ImageSafetyGate() };
const state = {
  current: null,
  trees: [],
  table: [],
  busy: false,
  editing: false,
  selectedDirectory: '',
  selectedZip: '',
  displayedTreeIndex: 0,
  sessionGeneration: 0,
};
const { render: renderTrees, keepSelectedVisible: keepSelectedTreeVisible } = createTreeListView({
  element,
  state,
});
const { render: renderTable } = createTableView({ element, state, api, execute });
const speciesReview = createSpeciesReview({ element, api, state, execute });
const mergeView = createMergeView({
  element,
  api,
  onLoad: async (directory) => {
    const previousDirectory = state.selectedDirectory;
    const previousZip = state.selectedZip;
    state.selectedDirectory = directory;
    state.selectedZip = '';
    await loadData(directory, '');
    const loaded = (state.current?.dataDir || '').toLowerCase() === directory.toLowerCase();
    if (!loaded) {
      state.selectedDirectory = previousDirectory;
      state.selectedZip = previousZip;
    }
    return loaded;
  },
});

function setStatus(message, kind = 'ready') {
  element('status-text').textContent = message;
  element('status-text').title = message;
  for (const id of ['footer-dot', 'connection-dot']) {
    element(id).className = `status-dot ${kind}`;
  }
  element('connection-label').textContent =
    kind === 'error' ? '需要处理' : kind === 'ready' ? '本地已连接' : '处理中';
}

function updateEnabled() {
  const disabled = state.busy || !state.current?.loaded;
  document.querySelectorAll('[data-requires-data]').forEach((control) => {
    control.disabled = disabled;
  });
  element('choose-data').disabled = state.busy;
  element('choose-zip').disabled = state.busy;
  element('open-merge').disabled = state.busy;
  element('tree-search').disabled = disabled;
  document.body.classList.toggle('busy', state.busy);
}

function pathName(value) {
  return (value || '').split(/[\\/]/).filter(Boolean).pop() || '未选择';
}

function showState(value) {
  if (!value) return;
  state.current = value;
  speciesReview.onState(value);
  element('data-name').textContent = pathName(value.dataDir);
  element('data-name').title = `${value.dataDir || ''}\n${value.zipPath || ''}`;
  element('summary-trees').textContent = value.treeCount || '—';
  element('summary-frames').textContent = value.frameCount || '—';
  element('current-tree').textContent = value.treeId || '—';
  element('frame-name').textContent = value.frame || '未选择帧';
  element('frame-position').textContent = value.frameCount
    ? `${value.frameIndex} / ${value.frameCount}`
    : '— / —';
  element('mark-mode').textContent = value.markMode || '未选中树';
  renderDualFrameInfo(value.dualFrameInfo, value.loaded, value.autoFrame);
  element('save-mark').textContent = value.markDirty ? '保存校正 · 未保存' : '保存校正';
  renderPhotoMetadata(value);
  element('heat-title').textContent = value.heatTitle || '注意力热力图';
  element('recognition-result').textContent = value.recognition || '选择树木后点击识别';
  for (const key of ['autoFrame', 'dualFrame', 'levelView', 'lowDistortion', 'lockView']) {
    element(`option-${key}`).checked = Boolean(value[key]);
  }
  element('option-frameStrategy').value = value.frameStrategy === 'nearest' ? 'nearest' : 'quality';
  for (const key of [
    'cal',
    'calV',
    'cropWidth',
    'cropHeight',
    'bearing',
    'distance',
    'elevation',
    'viewPan',
    'viewTilt',
    'viewFov',
  ]) {
    const input = element(`option-${key}`);
    const unavailableTarget =
      value.loaded &&
      value.targetValid === false &&
      ['bearing', 'distance', 'elevation'].includes(key);
    input.value = unavailableTarget
      ? ''
      : Number(value[key] ?? 0).toFixed(key === 'viewFov' ? 0 : 2);
    input.placeholder = unavailableTarget ? '不可用' : '';
  }
  renderTrees();
  updateEnabled();
}

function showImage(name, data) {
  const image = element(`${name}-image`);
  const empty = element(`${name}-empty`);
  if (data) image.src = data;
  else image.removeAttribute('src');
  image.classList.toggle('visible', Boolean(data));
  empty.hidden = Boolean(data);
}

function showProtectedImage(name, data, detection) {
  const result = imageSafetyGates[name].update(data, detection);
  showImage(name, result.image);
  element(`${name}-risk-cover`).hidden = !result.blocked;
}

function renderCropRisk(detection) {
  const note = element('crop-risk-note');
  const complete = detection?.status === 'complete';
  const detected = complete && (detection.personDetected || detection.headDetected);
  note.hidden = !state.current?.loaded;
  note.dataset.state = !complete ? 'detector-unavailable' : detected ? 'detected' : 'unverified';
  note.textContent = !complete
    ? '切图人体/头部检测不可用；不能排除头皮，请人工核查。'
    : detected
      ? '切图检测到疑似人体或头部；模型可能误报，请人工核查。'
      : '切图未检出人体或头部，但模型可能漏检，不能排除头皮。';
}

async function refreshImages() {
  const images = await api.images();
  showImage('pano', images.panorama);
  showProtectedImage('photo', images.photo, images.photoPeopleDetection);
  showProtectedImage('crop', images.crop, images.cropPeopleDetection);
  showImage('heat', images.heat);
  renderCropRisk(images.cropPeopleDetection);
  await speciesReview.update(state.current, images.crop);
}

async function execute(message, action, options = {}) {
  if (state.busy) return undefined;
  state.busy = true;
  updateEnabled();
  setStatus(message, 'busy');
  try {
    const result = await action();
    if (result && typeof result === 'object' && Object.hasOwn(result, 'loaded')) showState(result);
    else showState(await api.state());
    if (options.refreshTrees) {
      state.trees = await api.trees();
      renderTrees();
    }
    if (options.images !== false && state.current?.loaded) await refreshImages();
    setStatus(options.success || state.current?.status || '就绪');
    return result;
  } catch (error) {
    try {
      const current = await api.state();
      if (options.refreshTrees) state.trees = await api.trees();
      if (!current.loaded) {
        state.trees = [];
        state.table = [];
        showImage('pano', null);
        showImage('heat', null);
        await speciesReview.update(null, null);
        showProtectedImage('photo', null, null);
        showProtectedImage('crop', null, null);
        element('crop-risk-note').hidden = true;
      }
      showState(current);
      if (current.loaded && (options.images !== false || options.recoverImages))
        await refreshImages();
    } catch {
      // 保留最初的错误，避免状态恢复失败掩盖真正原因。
    }
    setStatus(error?.message || '操作失败，请检查数据和日志。', 'error');
    return undefined;
  } finally {
    state.busy = false;
    updateEnabled();
  }
}

async function loadData(directory, zip) {
  state.sessionGeneration += 1;
  state.editing = false;
  updateEditMode();
  await execute('正在加载数据与全景帧，请稍候…', () => api.load(directory, zip), {
    refreshTrees: true,
  });
}

function updateEditMode() {
  element('edit-mark').textContent = state.editing ? '完成调整' : '调整红圈';
  element('edit-mark').setAttribute('aria-pressed', String(state.editing));
  element('photo-stage').classList.toggle('editing', state.editing);
  element('pano-stage').classList.toggle('editing', state.editing);
  element('pano-hint').textContent = state.editing ? '点击或拖动至树干位置' : '拖动旋转 · 滚轮缩放';
  element('edit-hint').hidden = !state.editing;
  if (!state.editing) element('mark-cursor').hidden = true;
}

function bindEvents() {
  mergeView.bind();
  setupImageFocus({ element, state });
  for (const name of ['photo', 'crop']) {
    element(`${name}-risk-reveal`).addEventListener('click', () => {
      if (state.busy) return;
      const image = imageSafetyGates[name].reveal();
      if (!image) return;
      showImage(name, image);
      element(`${name}-risk-cover`).hidden = true;
      setStatus('已选择查看当前图片；请注意画面可能包含人体或头部。');
    });
  }
  window.addEventListener('resize', keepSelectedTreeVisible);
  element('choose-data').addEventListener('click', async () => {
    try {
      const directory = await api.chooseData();
      if (!directory) return;
      state.selectedDirectory = directory;
      state.selectedZip = '';
      await loadData(directory, '');
    } catch {
      setStatus('无法打开数据目录选择窗口，请重试。', 'error');
    }
  });
  element('choose-zip').addEventListener('click', async () => {
    try {
      const zip = await api.chooseZip();
      if (!zip) return;
      state.selectedZip = zip;
      await loadData(state.selectedDirectory, zip);
    } catch {
      setStatus('无法打开全景包选择窗口，请重试。', 'error');
    }
  });
  element('tree-search').addEventListener('input', renderTrees);
  element('tree-list').addEventListener('click', async (event) => {
    const row = event.target.closest('[data-index]');
    if (row && !state.busy)
      await execute('正在定位树木…', () => api.selectTree(Number(row.dataset.index)));
  });
  element('previous-tree').addEventListener('click', () => {
    const index =
      state.current.treeIndex <= 1 ? state.current.treeCount : state.current.treeIndex - 1;
    execute('正在定位上一棵树…', () => api.selectTree(index));
  });
  element('next-tree').addEventListener('click', () => {
    const index =
      state.current.treeIndex >= state.current.treeCount ? 1 : state.current.treeIndex + 1;
    execute('正在定位下一棵树…', () => api.selectTree(index));
  });
  element('nearest-tree').addEventListener('click', () =>
    execute('正在查找当前帧最近的树…', () => api.nearestTree()),
  );
  element('previous-frame').addEventListener('click', () =>
    execute('正在加载上一帧…', () => api.stepFrame(-1)),
  );
  element('next-frame').addEventListener('click', () =>
    execute('正在加载下一帧…', () => api.stepFrame(1)),
  );
  document.querySelectorAll('[data-option]').forEach((control) => {
    control.addEventListener('change', () => {
      if (control.type === 'number' && (!control.value.trim() || !control.checkValidity())) {
        showState(state.current);
        setStatus('请输入允许范围内的有效数值。', 'error');
        return;
      }
      const value =
        control.type === 'checkbox'
          ? control.checked
          : control instanceof HTMLSelectElement
            ? control.value
            : Number(control.value);
      if (typeof value === 'number' && !Number.isFinite(value)) return;
      execute('正在更新定位与投影…', () => api.setOptions({ [control.dataset.option]: value }));
    });
  });
  element('edit-mark').addEventListener('click', () => {
    state.editing = !state.editing;
    updateEditMode();
  });
  element('reset-mark').addEventListener('click', () =>
    execute('正在恢复自动红圈…', () => api.resetMark()),
  );
  element('save-mark').addEventListener('click', () =>
    execute('正在保存人工校正…', () => api.saveMark(), {
      success: '人工校正已保存到当前数据目录。',
    }),
  );
  element('save-crop').addEventListener('click', async () => {
    try {
      const result = await api.saveCrop();
      if (result) {
        const backup = result.backupPath ? `；旧文件备份：${result.backupPath}` : '';
        setStatus(`切图已保存：${result.path}${backup}`);
      }
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });
  element('recognize').addEventListener('click', () => speciesReview.run());
  element('open-table').addEventListener('click', async () => {
    const rows = await execute('正在计算树心—全景对照表…', () => api.buildTable(), {
      images: false,
    });
    if (!rows) return;
    state.table = rows;
    element('table-search').value = '';
    renderTable();
    element('table-dialog').showModal();
  });
  element('close-table').addEventListener('click', () => element('table-dialog').close());
  element('table-search').addEventListener('input', renderTable);
  for (const format of ['csv', 'xlsx']) {
    element(`export-${format}`).addEventListener('click', async () => {
      try {
        const result = await api.exportTable(format);
        if (result) setStatus(`对照表已导出：${result.path}`);
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
  }
  document.addEventListener('keydown', (event) => {
    if (
      (event.target instanceof Element &&
        event.target.closest('input, select, textarea, [contenteditable="true"]')) ||
      element('table-dialog').open ||
      element('merge-dialog').open ||
      element('species-preview-dialog').open ||
      state.busy ||
      !state.current?.loaded
    )
      return;
    if (event.key === 'PageUp') {
      event.preventDefault();
      element('previous-frame').click();
    }
    if (event.key === 'PageDown') {
      event.preventDefault();
      element('next-frame').click();
    }
  });
  const interactionContext = {
    element,
    state,
    api,
    execute,
    showPanorama: (data) => showImage('pano', data),
  };
  setupPhotoInteraction(interactionContext);
  setupPanoramaInteraction(interactionContext);
}

async function start() {
  bindEvents();
  updateEnabled();
  if (!api) {
    setStatus('桌面桥接不可用，请从 TreeExtract 桌面程序启动。', 'error');
    return;
  }
  try {
    await speciesReview.initialize();
    const defaults = await api.defaults();
    state.selectedDirectory = defaults.dataDir;
    state.selectedZip = defaults.zipPath;
    await loadData('', '');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

start();
