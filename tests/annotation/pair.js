'use strict';

(() => {
  const core = globalThis.TreeAnnotationCore;
  const ids = [
    'labels-file',
    'predictions-file',
    'pairs-dir',
    'reviewer',
    'export',
    'status',
    'previous',
    'next',
    'sample-title',
    'identity',
    'image-a',
    'image-b',
    'same-tree',
    'target-tree',
    'candidates-visible',
    'apply',
    'clear',
  ];
  const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const state = {
    labels: null,
    predictions: null,
    files: new Map(),
    entries: [],
    unavailable: 0,
    index: 0,
    urls: [],
    ready: false,
    dirty: false,
    busy: false,
    token: 0,
  };
  const current = () => state.entries[state.index] || null;
  const valueOf = (value) => (value === null ? 'unknown' : value ? 'yes' : 'no');
  const boolOf = (value) => (value === 'unknown' ? null : value === 'yes');

  function status(message, error = false) {
    ui.status.textContent = message;
    ui.status.classList.toggle('error', error);
  }

  function resetImages() {
    state.ready = false;
    for (const url of state.urls) URL.revokeObjectURL(url);
    state.urls = [];
    for (const id of ['image-a', 'image-b']) {
      ui[id].hidden = true;
      ui[id].removeAttribute('src');
    }
  }

  function renderForm() {
    const entry = current();
    const canEdit = Boolean(entry && state.ready && !state.busy);
    for (const id of ['labels-file', 'predictions-file', 'pairs-dir', 'reviewer'])
      ui[id].disabled = state.busy;
    for (const id of ['same-tree', 'target-tree', 'candidates-visible', 'apply', 'clear'])
      ui[id].disabled = !canEdit;
    ui.previous.disabled = !entry || state.index <= 0 || state.busy;
    ui.next.disabled = !entry || state.index >= state.entries.length - 1 || state.busy;
    ui.export.disabled = !state.labels || !state.predictions || state.busy;
    if (!entry) {
      ui['sample-title'].textContent = '没有可复核的双帧候选';
      ui.identity.textContent = '';
      return;
    }
    const pair = entry.label.pair;
    ui['same-tree'].value = pair ? valueOf(pair.sameTree) : 'unknown';
    ui['target-tree'].value = pair ? valueOf(pair.bothAreTarget) : 'unknown';
    ui['candidates-visible'].checked = Boolean(pair && pair.candidateVisible);
    ui['sample-title'].textContent =
      `第 ${state.index + 1} / ${state.entries.length} 组 · 树号 ${entry.label.treeId}`;
    ui.identity.textContent = `样本 ${entry.label.sampleId} · A ${entry.evidence.frameA} · B ${entry.evidence.frameB} · 第 ${entry.evidence.attempt} 次尝试`;
  }

  function rebuildEntries() {
    state.token++;
    resetImages();
    state.entries = [];
    state.index = 0;
    state.unavailable = 0;
    if (!state.labels || !state.predictions) {
      renderForm();
      return;
    }
    if (state.labels.dataset !== state.predictions.dataset)
      throw new Error('标注与预测的数据集不一致');
    const labels = new Map(state.labels.labels.map((label) => [label.sampleId, label]));
    const seen = new Set();
    for (const sample of state.predictions.samples) {
      if (!sample || typeof sample.sampleId !== 'string' || seen.has(sample.sampleId))
        throw new Error('预测样本无效或重复');
      seen.add(sample.sampleId);
      if (!sample.dual || sample.dual.state !== 'success') continue;
      if (!sample.dualEvidence || sample.dualEvidence.state !== 'available') {
        state.unavailable++;
        continue;
      }
      const label = labels.get(sample.sampleId);
      if (!label) throw new Error(`缺少对应标注：${sample.sampleId}`);
      const evidence = core.validatePairPrediction(sample, label, state.labels.dataset);
      core.validatePairLabel(label, evidence);
      state.entries.push({ sample, label, evidence });
    }
    renderForm();
  }

  async function checkedBlob(file, image) {
    if (!file) throw new Error('缺少一张 A/B 图证');
    if (file.size > 64 * 1024 * 1024) throw new Error('图证超过大小限制');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const blob = new Blob([bytes], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    try {
      await core.verifyPairImage(bytes, bitmap.width, bitmap.height, image);
    } finally {
      bitmap.close();
    }
    return blob;
  }

  async function checkEntry(entry) {
    const evidence = core.validatePairPrediction(entry.sample, entry.label, state.labels.dataset);
    core.validatePairLabel(entry.label, evidence);
    const result = {};
    for (const key of ['panoA', 'panoAMarked', 'panoB', 'panoBMarked']) {
      const image = evidence.images[key];
      const name = image.path.slice('pairs/'.length);
      result[key] = await checkedBlob(state.files.get(name), image);
    }
    return result;
  }

  async function showCurrent() {
    const token = ++state.token;
    resetImages();
    const entry = current();
    renderForm();
    if (!entry) {
      status(`没有可显示图证；缺少图证的成功样本 ${state.unavailable} 条，不代表通过。`);
      return;
    }
    status('正在核验四张原始图证的文件 SHA-256 与尺寸……');
    try {
      const images = await checkEntry(entry);
      if (token !== state.token) return;
      const a = URL.createObjectURL(images.panoAMarked),
        b = URL.createObjectURL(images.panoBMarked);
      state.urls = [a, b];
      ui['image-a'].src = a;
      ui['image-b'].src = b;
      ui['image-a'].hidden = false;
      ui['image-b'].hidden = false;
      state.ready = true;
      renderForm();
      status(
        `四张图证文件 SHA-256 和尺寸一致。请结合独立资料判断；缺图成功样本 ${state.unavailable} 条。`,
      );
    } catch (error) {
      if (token === state.token) status(`图证不可用：${error.message}`, true);
    }
  }

  async function readJson(file) {
    if (!file || file.size > 20 * 1024 * 1024) throw new Error('文件不存在或超过大小限制');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    return JSON.parse(text);
  }

  ui['labels-file'].addEventListener('change', async () => {
    const file = ui['labels-file'].files[0];
    if (!file) return;
    if (state.dirty && !window.confirm('已有双帧复核尚未下载，确定放弃吗？')) {
      ui['labels-file'].value = '';
      return;
    }
    try {
      state.labels = core.validateDocument(await readJson(file));
      state.dirty = false;
      rebuildEntries();
      await showCurrent();
    } catch (error) {
      state.labels = null;
      rebuildEntries();
      status(`无法打开标注：${error.message}`, true);
    }
  });

  ui['predictions-file'].addEventListener('change', async () => {
    const file = ui['predictions-file'].files[0];
    if (!file) return;
    if (state.dirty && !window.confirm('已有双帧复核尚未下载，确定更换预测清单吗？')) {
      ui['predictions-file'].value = '';
      return;
    }
    try {
      const predictions = await readJson(file);
      if (
        predictions.schema !== 'treeextract.predictions.v1' ||
        !Array.isArray(predictions.samples) ||
        predictions.samples.length > 5000
      )
        throw new Error('请选择预测清单');
      state.predictions = predictions;
      rebuildEntries();
      await showCurrent();
    } catch (error) {
      state.predictions = null;
      rebuildEntries();
      status(`无法打开预测清单：${error.message}`, true);
    }
  });

  ui['pairs-dir'].addEventListener('change', async () => {
    try {
      const files = new Map();
      for (const file of ui['pairs-dir'].files) {
        if (!/^\d{6,}-pano(?:A|AMarked|B|BMarked)\.png$/.test(file.name)) continue;
        if (files.has(file.name)) throw new Error(`图证名称重复：${file.name}`);
        files.set(file.name, file);
      }
      if (!files.size) throw new Error('文件夹中没有双帧图证');
      state.files = files;
      await showCurrent();
    } catch (error) {
      state.files = new Map();
      state.token++;
      resetImages();
      renderForm();
      status(`图证文件夹不可用：${error.message}`, true);
    }
  });

  ui.previous.addEventListener('click', () => {
    if (state.index > 0) {
      state.index--;
      showCurrent();
    }
  });
  ui.next.addEventListener('click', () => {
    if (state.index + 1 < state.entries.length) {
      state.index++;
      showCurrent();
    }
  });
  ui.apply.addEventListener('click', () => {
    const entry = current();
    if (!entry || !state.ready) return;
    try {
      const label = core.applyPairReview(
        entry.label,
        state.labels.dataset,
        entry.evidence,
        {
          sameTree: boolOf(ui['same-tree'].value),
          bothAreTarget: boolOf(ui['target-tree'].value),
          candidateVisible: ui['candidates-visible'].checked,
        },
        ui.reviewer.value,
      );
      const index = state.labels.labels.findIndex((item) => item.sampleId === label.sampleId);
      state.labels.labels[index] = label;
      entry.label = label;
      state.dirty = true;
      renderForm();
      status('当前双帧复核已记录在页面内；请校验并下载 JSON。');
    } catch (error) {
      status(error.message, true);
    }
  });
  ui.clear.addEventListener('click', () => {
    const entry = current();
    if (!entry || !state.ready) return;
    const label = { ...entry.label, pair: null };
    const index = state.labels.labels.findIndex((item) => item.sampleId === label.sampleId);
    state.labels.labels[index] = label;
    entry.label = label;
    state.dirty = true;
    renderForm();
    status('当前双帧复核已清除；未知不计为通过。');
  });

  ui.export.addEventListener('click', async () => {
    if (!state.labels || !state.predictions || state.busy) return;
    state.busy = true;
    renderForm();
    try {
      core.validateDocument(state.labels);
      for (const label of state.labels.labels) {
        if (label.pair === null) continue;
        const entry = state.entries.find((item) => item.label.sampleId === label.sampleId);
        if (!entry) throw new Error(`找不到双帧图证：${label.sampleId}`);
        status(`正在复核图证：${label.sampleId}`);
        await checkEntry(entry);
      }
      const blob = new Blob([JSON.stringify(state.labels, null, 2) + '\n'], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = 'labels-with-pairs.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('已请求下载；请确认本地保存成功。模型候选不是人工真值。');
    } catch (error) {
      status(`复核未导出：${error.message}`, true);
    } finally {
      state.busy = false;
      renderForm();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) event.preventDefault();
  });
})();
