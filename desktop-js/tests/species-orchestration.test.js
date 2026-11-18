'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCombinedRecognition } = require('../src/species-orchestration');

test('本地和视觉同时启动，二者完成后才进行综合', async () => {
  const started = [];
  let finishLocal;
  let finishVisual;
  const localResult = new Promise((resolve) => {
    finishLocal = resolve;
  });
  const visualResult = new Promise((resolve) => {
    finishVisual = resolve;
  });
  const run = runCombinedRecognition({
    local: async () => {
      started.push('local');
      return localResult;
    },
    visual: async () => {
      started.push('visual');
      return visualResult;
    },
    synthesize: async (local, visual) => {
      started.push('synthesis');
      assert.equal(local.text, 'local result');
      assert.equal(visual.reason, 'visual result');
      return { candidate: { value: 'zhangshu', group: '常绿乔木', name: '香樟' } };
    },
  });
  await Promise.resolve();
  assert.deepEqual(started, ['local', 'visual']);
  finishVisual({ reason: 'visual result' });
  await Promise.resolve();
  assert.deepEqual(started, ['local', 'visual']);
  finishLocal({ text: 'local result' });
  const result = await run;
  assert.deepEqual(started, ['local', 'visual', 'synthesis']);
  assert.equal(result.localCompleted, true);
  assert.equal(result.synthesis.candidate.group, '常绿乔木');
});

test('任一模型失败时保留另一项结果，不伪造综合结论', async () => {
  let syntheses = 0;
  const result = await runCombinedRecognition({
    local: async () => ({ text: 'offline' }),
    visual: async () => {
      throw new Error('network');
    },
    synthesize: async () => {
      syntheses += 1;
    },
  });
  assert.equal(result.localCompleted, true);
  assert.equal(result.visual, null);
  assert.ok(result.visualError);
  assert.equal(result.synthesis, null);
  assert.equal(syntheses, 0);
});
