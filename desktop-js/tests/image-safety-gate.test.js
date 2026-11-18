'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('已检出的人体或头部默认遮挡，查看确认只对同一图片有效', async () => {
  const { ImageSafetyGate } = await import('../src/renderer/image-safety-gate.mjs');
  const gate = new ImageSafetyGate();
  const head = { status: 'complete', personDetected: true, headDetected: true };
  const person = { status: 'complete', personDetected: true, headDetected: false };
  assert.deepEqual(gate.update('image-a', head), { image: null, blocked: true });
  assert.equal(gate.reveal(), 'image-a');
  assert.deepEqual(gate.update('image-a', head), { image: 'image-a', blocked: false });
  assert.deepEqual(gate.update('image-b', person), { image: null, blocked: true });
  assert.deepEqual(gate.update('image-c', head), { image: null, blocked: true });
  assert.equal(gate.reveal(), 'image-c');
  assert.deepEqual(gate.update('image-b', person), { image: null, blocked: true });
});

test('空图、未检出或检测不可用不伪称安全，也不保留旧查看确认', async () => {
  const { ImageSafetyGate } = await import('../src/renderer/image-safety-gate.mjs');
  const gate = new ImageSafetyGate();
  const head = { status: 'complete', headDetected: true };
  gate.update('image-a', head);
  gate.reveal();
  assert.deepEqual(gate.update(null, head), { image: null, blocked: false });
  assert.equal(gate.reveal(), null);
  assert.deepEqual(gate.update('image-a', head), { image: null, blocked: true });
  assert.deepEqual(gate.update('image-a', { status: 'unavailable' }), {
    image: 'image-a',
    blocked: false,
  });
  assert.deepEqual(gate.update('image-a', head), { image: null, blocked: true });
});
