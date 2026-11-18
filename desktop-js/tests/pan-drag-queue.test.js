'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const queueModule = import('../src/renderer/pan-drag-queue.mjs');

test('快速拖动合并中间位置，串行渲染并保留最终方向', async () => {
  const { createPanDragQueue } = await queueModule;
  let resolveFirst;
  const waitFirst = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const calls = [];
  const rendered = [];
  let active = 0;
  let maxActive = 0;
  const queue = createPanDragQueue({
    startX: 0,
    startY: 0,
    startPan: 90,
    startTilt: 0,
    panScale: -0.5,
    tiltScale: 0.25,
    fov: 90,
    async pan(x, y, fov) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push([x, y, fov]);
      if (calls.length === 1) await waitFirst;
      active -= 1;
      return { sequence: calls.length };
    },
    async images() {
      return { panorama: 'preview' };
    },
    onFrame(frame, x, y) {
      rendered.push([frame.panorama, x, y]);
    },
  });
  queue.move(10, 4);
  const result = queue.run();
  queue.move(20, 8);
  queue.move(35, 12);
  queue.finish(40, 16);
  queue.move(999, 999);
  resolveFirst();
  assert.deepEqual(await result, { sequence: 2 });
  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [
    [-5, 1, 90],
    [-15, 3, 90],
  ]);
  assert.deepEqual(rendered, [
    ['preview', 10, 4],
    ['preview', 40, 16],
  ]);
});

test('没有位移或释放后不会产生多余请求', async () => {
  const { createPanDragQueue } = await queueModule;
  let calls = 0;
  const queue = createPanDragQueue({
    startX: 10,
    startY: 10,
    startPan: 90,
    startTilt: 0,
    panScale: 1,
    tiltScale: 1,
    fov: 90,
    async pan() {
      calls += 1;
    },
    async images() {
      throw new Error('没有位移时不应获取图片');
    },
    onFrame() {},
  });
  queue.finish(10, 10);
  assert.equal(await queue.run(), undefined);
  assert.equal(calls, 0);
});

test('后端错误向调用者传播，不能伪装成渲染成功', async () => {
  const { createPanDragQueue } = await queueModule;
  const queue = createPanDragQueue({
    startX: 0,
    startY: 0,
    startPan: 90,
    startTilt: 0,
    panScale: 1,
    tiltScale: 1,
    fov: 90,
    async pan() {
      throw new Error('render failed');
    },
    async images() {},
    onFrame() {
      assert.fail('失败后不能展示新帧');
    },
  });
  queue.finish(1, 0);
  await assert.rejects(queue.run(), /render failed/);
});

test('拖过俯仰限位再拉回时，最终视角仍对应起点与指针位置', async () => {
  const { createPanDragQueue } = await queueModule;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let tilt = 80;
  const deltas = [];
  const queue = createPanDragQueue({
    startX: 0,
    startY: 0,
    startPan: 90,
    startTilt: tilt,
    panScale: 1,
    tiltScale: 1,
    fov: 90,
    async pan(_x, y) {
      deltas.push(y);
      if (deltas.length === 1) await blocked;
      tilt = Math.max(-89, Math.min(89, tilt + y));
      return { viewPan: 90, viewTilt: tilt };
    },
    async images() {
      return { panorama: 'preview' };
    },
    onFrame() {},
  });
  queue.move(0, 25);
  const result = queue.run();
  queue.finish(0, 5);
  release();
  await result;
  assert.deepEqual(deltas, [9, -4]);
  assert.equal(tilt, 85);
});

test('跨越 0° 时按最短方向旋转，最终方向正确', async () => {
  const { createPanDragQueue } = await queueModule;
  const calls = [];
  const queue = createPanDragQueue({
    startX: 0,
    startY: 0,
    startPan: 359,
    startTilt: 0,
    panScale: 1,
    tiltScale: 1,
    fov: 90,
    async pan(x, y) {
      calls.push([x, y]);
      return { viewPan: 9, viewTilt: 0 };
    },
    async images() {
      return { panorama: 'preview' };
    },
    onFrame() {},
  });
  queue.finish(10, 0);
  await queue.run();
  assert.deepEqual(calls, [[10, 0]]);
});

test('新帧等待前一帧解码提交，期间继续合并最新指针', async () => {
  const { createPanDragQueue } = await queueModule;
  let release;
  let notify;
  const decoding = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    notify = resolve;
  });
  const displayed = [];
  const queue = createPanDragQueue({
    startX: 0,
    startY: 0,
    startPan: 0,
    startTilt: 0,
    panScale: 1,
    tiltScale: 1,
    fov: 90,
    async pan() {
      return {};
    },
    async images() {
      return { panorama: 'frame' };
    },
    async onFrame(_frame, x) {
      displayed.push(x);
      if (displayed.length === 1) {
        notify();
        await decoding;
      }
    },
  });
  queue.move(10, 0);
  const run = queue.run();
  await started;
  queue.move(20, 0);
  queue.finish(30, 0);
  assert.deepEqual(displayed, [10]);
  release();
  await run;
  assert.deepEqual(displayed, [10, 30]);
});
