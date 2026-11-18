'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../src/renderer/session-target.mjs');

function fixture() {
  return {
    sessionGeneration: 3,
    current: {
      loaded: true,
      dataDir: 'E:\\dataset-a',
      zipPath: 'E:\\dataset-a\\Camera4.zip',
      treeIndex: 1,
      treeId: 92,
      frame: '100.1.jpg',
      viewPan: 10,
    },
  };
}

test('界面目标身份保留原有字段与顺序，同目录重新加载也使旧任务失效', async () => {
  const { sessionTarget } = await modulePromise;
  const state = fixture();
  const initial = sessionTarget(state);
  assert.equal(
    initial,
    JSON.stringify([3, state.current.dataDir, state.current.zipPath, 1, 92, '100.1.jpg']),
  );
  state.sessionGeneration += 1;
  assert.notEqual(sessionTarget(state), initial);
});

test('换数据、全景包、树序号、树号或帧均产生不同身份', async () => {
  const { sessionTarget } = await modulePromise;
  const alternatives = {
    dataDir: 'E:\\dataset-b',
    zipPath: 'E:\\another.zip',
    treeIndex: 2,
    treeId: 93,
    frame: '101.1.jpg',
  };
  for (const [key, value] of Object.entries(alternatives)) {
    const state = fixture();
    const original = sessionTarget(state);
    state.current[key] = value;
    assert.notEqual(sessionTarget(state), original, key);
  }
});

test('视角和识别展示不改变目标身份，切图变更仍由后端 scope 独立校验', async () => {
  const { sessionTarget } = await modulePromise;
  const state = fixture();
  const before = sessionTarget(state);
  Object.assign(state.current, {
    viewPan: 80,
    viewTilt: 20,
    viewFov: 90,
    recognition: 'another result',
    markDirty: true,
  });
  assert.equal(sessionTarget(state), before);
});

test('支持初始空会话及显式传入的最新状态，不依赖全局窗口', async () => {
  const { sessionTarget } = await modulePromise;
  assert.equal(sessionTarget({ current: null }), '[0,null,null,null,null,null]');
  const state = fixture();
  const next = { ...state.current, frame: '102.1.jpg' };
  assert.notEqual(sessionTarget(state, next), sessionTarget(state));
  assert.equal(state.current.frame, '100.1.jpg');
});
