'use strict';

// 本地模型和视觉模型互不依赖，同时启动；复核只使用两项实际完成的结果。
async function runCombinedRecognition({ local, visual, synthesize }) {
  const [localResult, visualResult] = await Promise.allSettled([
    Promise.resolve().then(local),
    Promise.resolve().then(visual),
  ]);
  const outcome = {
    localCompleted: localResult.status === 'fulfilled',
    localError: localResult.status === 'rejected' ? '本地识别未完成，请检查模型和数据。' : '',
    visual: visualResult.status === 'fulfilled' ? visualResult.value : null,
    visualError: visualResult.status === 'rejected' ? '云端视觉识别未完成，请检查网络和密钥。' : '',
    synthesis: null,
    synthesisError: '',
  };
  if (localResult.status === 'fulfilled' && visualResult.status === 'fulfilled') {
    try {
      outcome.synthesis = await synthesize(localResult.value, visualResult.value);
    } catch {
      outcome.synthesisError = '综合复核未完成；请参考原始结果并人工确认。';
    }
  } else {
    outcome.synthesisError = '本地或视觉结果缺失，未生成综合结论。';
  }
  return outcome;
}

module.exports = { runCombinedRecognition };
