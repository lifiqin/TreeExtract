'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dualModule = import('../src/renderer/dual-frame-view.mjs');
const photoModule = import('../src/renderer/photo-metadata-view.mjs');

function fakeDocument(ids) {
  const elements = new Map();
  const makeElement = () => ({
    dataset: {},
    textContent: '',
    hidden: false,
    children: [],
    replaceChildren() {
      this.children = [];
    },
    append(child) {
      this.children.push(child);
    },
  });
  for (const id of ids) elements.set(id, makeElement());
  return {
    getElementById(id) {
      assert.ok(elements.has(id), `Unexpected element: ${id}`);
      return elements.get(id);
    },
    createElement: makeElement,
  };
}

test('双帧状态模型区分成功、回退、固定帧及未知状态', async () => {
  const { dualFrameViewModel } = await dualModule;
  assert.equal(dualFrameViewModel(null).status, 'unavailable');
  const value = dualFrameViewModel(
    { state: 'fallback', reason: '证据不足', frameA: 'a.jpg', attempts: 3 },
    true,
    false,
  );
  assert.equal(value.label, '双帧：单帧回退');
  assert.equal(value.frameMode, 'fixed');
  assert.match(value.frames, /固定当前帧，换树恢复自动/);
  assert.match(value.reason, /证据不足.*辅助帧尝试 3 次/);
  assert.equal(value.showAttempts, false);
  assert.equal(dualFrameViewModel({ state: 'unknown' }, true, true).status, 'unavailable');
  assert.equal(dualFrameViewModel({ state: 'success' }, true, true).label, '双帧：候选段通过');
});

test('逐帧诊断只展示有限数据，并在切换目标时清除旧内容', async () => {
  const { dualFrameViewModel, renderDualFrameInfo } = await dualModule;
  const info = {
    state: 'fallback',
    attemptDetails: [
      {
        frameB: '<frame>.jpg',
        primaryCandidates: 2,
        secondaryCandidates: 0,
        axisErrorM: 0.25,
        axisLimitM: 0.75,
        appearanceCorrelation: NaN,
        appearanceStatus: 'matched',
        reason: '需复核',
      },
    ],
  };
  const model = dualFrameViewModel(info, true, true);
  assert.match(model.attempts[0], /轴心偏差 0\.25 m/);
  assert.match(model.attempts[0], /纹理相似，仍需复核目标/);
  assert.doesNotMatch(model.attempts[0], /NaN|准确率/);
  const doc = fakeDocument([
    'dual-summary',
    'dual-result',
    'dual-reason',
    'dual-frames',
    'dual-diagnostics',
    'dual-diagnostics-title',
    'dual-diagnostics-list',
  ]);
  renderDualFrameInfo(info, true, true, doc);
  assert.equal(doc.getElementById('dual-diagnostics').hidden, false);
  assert.match(doc.getElementById('dual-diagnostics-list').children[0].textContent, /<frame>/);
  renderDualFrameInfo({}, false, false, doc);
  assert.equal(doc.getElementById('dual-diagnostics').hidden, true);
  assert.equal(doc.getElementById('dual-diagnostics-list').children.length, 0);
});

test('缺目标时隐藏旧角度，零距离和未经人像检测风险仍如实显示', async () => {
  const { photoMetadataViewModel, renderPhotoMetadata } = await photoModule;
  const missing = photoMetadataViewModel({
    loaded: true,
    targetValid: false,
    bearing: 88,
    elevation: 20,
    cameraHorizontalDistance: 0,
    distanceUsesTrunkAxis: true,
    frameStrategy: 'nearest',
    photoRisk: { state: 'unavailable', reason: '无法确定树干方向' },
  });
  assert.match(missing.details, /方位 — · 水平距离 0\.00 m（树干） · 仰角 —/);
  assert.match(missing.warning, /0\.00 m/);
  assert.equal(missing.riskReason, '无法确定树干方向');
  const valid = photoMetadataViewModel({
    loaded: true,
    targetValid: true,
    bearing: 12.34,
    elevation: -3.45,
    cameraHorizontalDistance: 3,
    photoRisk: { state: 'unverified', reason: '人体检测可能漏检，仍需人工核查' },
  });
  assert.match(valid.details, /方位 12\.3°.*仰角 -3\.5°/);
  assert.equal(valid.warning, '');
  assert.match(valid.riskReason, /可能漏检/);
  const doc = fakeDocument(['photo-details', 'distance-warning', 'photo-risk-note']);
  renderPhotoMetadata({ loaded: true, frameStrategy: 'nearest', cameraHorizontalDistance: 1 }, doc);
  assert.equal(doc.getElementById('distance-warning').hidden, false);
  renderPhotoMetadata({}, doc);
  assert.equal(doc.getElementById('distance-warning').hidden, true);
  assert.equal(doc.getElementById('distance-warning').textContent, '');
  assert.equal(doc.getElementById('photo-risk-note').hidden, true);
});

test('邻树或重复帧警告与最近距离提示同时显示，切换目标时不沿用旧警告', async () => {
  const { photoMetadataViewModel, renderPhotoMetadata } = await photoModule;
  const warning = '与邻树 107 的方向接近，可能遮挡或误认；请切换视角人工核查。';
  const model = photoMetadataViewModel({
    loaded: true,
    frameStrategy: 'nearest',
    cameraHorizontalDistance: 1,
    frameSelectionWarning: warning,
  });
  assert.match(model.warning, /1\.00 m/);
  assert.match(model.warning, /邻树 107/);
  const doc = fakeDocument(['photo-details', 'distance-warning', 'photo-risk-note']);
  renderPhotoMetadata({ loaded: true, frameSelectionWarning: warning }, doc);
  assert.equal(doc.getElementById('distance-warning').hidden, false);
  renderPhotoMetadata({ loaded: true, frameSelectionWarning: '' }, doc);
  assert.equal(doc.getElementById('distance-warning').hidden, true);
  assert.equal(doc.getElementById('distance-warning').textContent, '');
  assert.equal(
    photoMetadataViewModel({ loaded: false, frameSelectionWarning: warning }).warning,
    '',
  );
});
