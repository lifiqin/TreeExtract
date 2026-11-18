'use strict';

(() => {
  const core = globalThis.TreeAnnotationCore;
  const get = (id) => document.getElementById(id);
  const ui = Object.fromEntries(
    [
      'labels-file',
      'photos-dir',
      'reviewer',
      'review-method',
      'export',
      'status',
      'previous',
      'next',
      'sample-title',
      'identity',
      'image-shell',
      'photo',
      'point-layer',
      'point-border',
      'point',
      'coordinates',
      'clear-point',
      'point-x',
      'point-y',
      'set-point',
      'target',
      'person',
      'head',
      'scalp',
      'review-info',
      'apply-reviewer',
    ].map((id) => [id, get(id)]),
  );
  const state = {
    document: null,
    files: new Map(),
    index: 0,
    imageUrl: null,
    imageReady: false,
    dirty: false,
    renderToken: 0,
    exporting: false,
  };

  function status(message, error = false) {
    ui.status.textContent = message;
    ui.status.classList.toggle('error', error);
  }

  function boolToValue(value) {
    return value === null ? 'unknown' : value ? 'yes' : 'no';
  }
  function valueToBool(value) {
    return value === 'unknown' ? null : value === 'yes';
  }
  function current() {
    return state.document?.labels[state.index] || null;
  }

  function resetImage() {
    state.imageReady = false;
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.imageUrl = null;
    ui.photo.removeAttribute('src');
    ui['image-shell'].hidden = true;
  }

  async function checkedBlob(file, label) {
    if (!file) throw new Error('未找到该样本的 clean 照片');
    if (file.size > 64 * 1024 * 1024) throw new Error('照片超过大小限制');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    try {
      await core.verifyImage(bytes, bitmap.width, bitmap.height, label);
    } finally {
      bitmap.close();
    }
    return blob;
  }

  function renderForm() {
    const label = current();
    const canEdit = Boolean(label && state.imageReady && !state.exporting);
    for (const id of ['labels-file', 'photos-dir', 'reviewer', 'review-method']) {
      ui[id].disabled = state.exporting;
    }
    for (const id of [
      'target',
      'person',
      'head',
      'scalp',
      'clear-point',
      'point-x',
      'point-y',
      'set-point',
      'apply-reviewer',
    ]) {
      ui[id].disabled = !canEdit;
    }
    ui['apply-reviewer'].disabled = !canEdit || !core.hasPrimaryReview(label);
    ui.previous.disabled = !state.document || state.index <= 0 || state.exporting;
    ui.next.disabled =
      !state.document || state.index >= state.document.labels.length - 1 || state.exporting;
    ui.export.disabled = !state.document || state.exporting;
    if (!label) {
      ui['sample-title'].textContent = '尚未加载样本';
      ui.identity.textContent = '';
      ui['coordinates'].textContent = '树干中点：未知';
      ui['review-info'].textContent = '尚未标注。';
      ui['point-layer'].hidden = true;
      return;
    }
    ui.target.value = boolToValue(label.targetVisible);
    ui.person.value = boolToValue(label.personVisible);
    ui.head.value = boolToValue(label.headVisible);
    ui.scalp.value = boolToValue(label.scalpVisible);
    ui['review-info'].textContent = core.hasPrimaryReview(label)
      ? `已记录：${label.reviewer} · ${label.reviewMethod === 'blind' ? '盲标' : '看过预测'}`
      : label.pair
        ? '仅有双帧复核；主帧尚未标注。'
        : '尚未标注。';
    const point = label.trunkCenter;
    ui['point-x'].value = point ? String(point.x) : '';
    ui['point-y'].value = point ? String(point.y) : '';
    ui['point-layer'].hidden = !point || !state.imageReady;
    if (point && state.imageReady) {
      for (const id of ['point-border', 'point']) {
        ui[id].setAttribute('cx', `${100 * point.x}%`);
        ui[id].setAttribute('cy', `${100 * point.y}%`);
      }
      ui.coordinates.textContent = `树干中点：x=${point.x.toFixed(4)}，y=${point.y.toFixed(4)}`;
    } else ui.coordinates.textContent = '树干中点：未知';
  }

  async function showCurrent() {
    const token = ++state.renderToken;
    resetImage();
    const label = current();
    if (!label) {
      renderForm();
      return;
    }
    ui['sample-title'].textContent =
      `第 ${state.index + 1} / ${state.document.labels.length} 张 · 树号 ${label.treeId}`;
    ui.identity.textContent = `样本 ${label.sampleId} · 帧 ${label.frameA || '缺失'} · SHA-256 ${label.imageSha256 || '缺失'}`;
    renderForm();
    if (!label.imageSha256) {
      status('当前没有可用照片，保持未知。');
      return;
    }
    status('正在核验当前照片的 SHA-256 和尺寸……');
    try {
      const name = core.sampleFileName(label, state.document.dataset);
      const blob = await checkedBlob(state.files.get(name), label);
      if (token !== state.renderToken) return;
      state.imageUrl = URL.createObjectURL(blob);
      ui.photo.src = state.imageUrl;
      ui['image-shell'].hidden = false;
      state.imageReady = true;
      renderForm();
      status('照片 SHA-256 和尺寸一致。仅在独立确认目标树后点击树干中点。');
    } catch (error) {
      if (token === state.renderToken) status(`无法打开当前照片：${error.message}`, true);
    }
  }

  function mutate(changes) {
    if (!current() || !state.imageReady || state.exporting) return;
    try {
      const label = core.applyReview(
        current(),
        state.document.dataset,
        changes,
        ui.reviewer.value,
        ui['review-method'].value,
      );
      state.document.labels[state.index] = label;
      state.dirty = true;
      renderForm();
      status('修改已保存在当前页面内；请点击“校验并下载标注 JSON”保存到本地。');
    } catch (error) {
      renderForm();
      status(error.message, true);
    }
  }

  ui['labels-file'].addEventListener('change', async () => {
    const file = ui['labels-file'].files[0];
    if (!file) return;
    if (state.dirty && !window.confirm('已有标注尚未下载，确定放弃并打开另一个文件吗？')) {
      ui['labels-file'].value = '';
      return;
    }
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('标注文件超过大小限制');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const parsed = JSON.parse(text);
      core.validateDocument(parsed);
      if (!parsed.labels.length) throw new Error('标注文件没有样本');
      state.document = parsed;
      state.index = 0;
      state.dirty = false;
      await showCurrent();
    } catch (error) {
      state.document = null;
      state.index = 0;
      state.renderToken++;
      resetImage();
      renderForm();
      status(`无法打开标注文件：${error.message}`, true);
    }
  });

  ui['photos-dir'].addEventListener('change', async () => {
    try {
      const files = new Map();
      for (const file of ui['photos-dir'].files) {
        if (!/^\d{6,}-clean\.jpg$/.test(file.name)) continue;
        if (files.has(file.name)) throw new Error(`照片文件名重复：${file.name}`);
        files.set(file.name, file);
      }
      if (!files.size) throw new Error('没有找到 clean 照片');
      state.files = files;
      await showCurrent();
    } catch (error) {
      state.files = new Map();
      state.renderToken++;
      resetImage();
      renderForm();
      status(`无法读取照片文件夹：${error.message}`, true);
    }
  });

  ui.previous.addEventListener('click', () => {
    if (state.index > 0) {
      state.index--;
      showCurrent();
    }
  });
  ui.next.addEventListener('click', () => {
    if (state.document && state.index < state.document.labels.length - 1) {
      state.index++;
      showCurrent();
    }
  });
  ui.photo.addEventListener('click', (event) => {
    try {
      mutate({
        targetVisible: true,
        trunkCenter: core.normalizedPoint(
          event.clientX,
          event.clientY,
          ui.photo.getBoundingClientRect(),
        ),
      });
    } catch (error) {
      status(error.message, true);
    }
  });
  ui['clear-point'].addEventListener('click', () => mutate({ trunkCenter: null }));
  ui['set-point'].addEventListener('click', () => {
    if (!ui['point-x'].value.trim() || !ui['point-y'].value.trim()) {
      status('请输入完整的 x、y 坐标。', true);
      return;
    }
    mutate({
      targetVisible: true,
      trunkCenter: {
        x: Number(ui['point-x'].value),
        y: Number(ui['point-y'].value),
      },
    });
  });
  ui.target.addEventListener('change', () => {
    const targetVisible = valueToBool(ui.target.value);
    mutate(targetVisible === true ? { targetVisible } : { targetVisible, trunkCenter: null });
  });
  for (const [id, key] of [
    ['person', 'personVisible'],
    ['head', 'headVisible'],
    ['scalp', 'scalpVisible'],
  ]) {
    ui[id].addEventListener('change', () => mutate({ [key]: valueToBool(ui[id].value) }));
  }
  ui['apply-reviewer'].addEventListener('click', () => mutate({}));

  ui.export.addEventListener('click', async () => {
    if (!state.document || state.exporting) return;
    state.exporting = true;
    renderForm();
    try {
      core.validateDocument(state.document);
      for (const label of state.document.labels) {
        if (!core.hasReview(label)) continue;
        status(`正在校验已标注照片：${label.sampleId}`);
        await checkedBlob(
          state.files.get(core.sampleFileName(label, state.document.dataset)),
          label,
        );
      }
      const blob = new Blob([JSON.stringify(state.document, null, 2) + '\n'], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'labels-reviewed.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('已请求下载标注文件。评估前请确认保存位置；未知项不会被当作通过。');
    } catch (error) {
      status(`标注未导出：${error.message}`, true);
    } finally {
      state.exporting = false;
      renderForm();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) event.preventDefault();
  });
})();
