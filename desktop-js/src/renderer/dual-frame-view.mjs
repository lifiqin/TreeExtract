// 双帧状态的展示规则与 DOM 更新独立于事件编排，便于单独测试。
const STATUS_LABELS = Object.freeze({
  unavailable: '双帧：未就绪',
  not_run: '双帧：未执行',
  disabled: '双帧：已关闭',
  manual: '当前：人工校正优先',
  success: '双帧：候选段通过',
  fallback: '双帧：单帧回退',
});

const APPEARANCE_LABELS = Object.freeze({
  not_attempted: '未比较纹理',
  missing_profile: '缺少纹理观测',
  insufficient_overlap: '共同可见段不足',
  width_mismatch: '树干宽度不一致',
  projection_error: '纹理投影失败',
  insufficient_texture: '纹理变化不足',
  correlation_low: '纹理一致性不足',
  matched: '纹理相似，仍需复核目标',
});

function describeAttempt(attempt, index) {
  const value = attempt && typeof attempt === 'object' ? attempt : {};
  const parts = [
    `第 ${index + 1} 次：${value.frameB || '未选择辅助帧'}`,
    `候选 A ${value.primaryCandidates ?? '—'} / B ${value.secondaryCandidates ?? '—'}`,
  ];
  if (Number.isFinite(value.axisErrorM) && Number.isFinite(value.axisLimitM)) {
    parts.push(
      `轴心偏差 ${value.axisErrorM.toFixed(2)} m（上限 ${value.axisLimitM.toFixed(2)} m）`,
    );
  }
  if (Number.isFinite(value.appearanceCorrelation)) {
    parts.push(`纹理相关 ${value.appearanceCorrelation.toFixed(2)}`);
  }
  parts.push(APPEARANCE_LABELS[value.appearanceStatus] || '未比较纹理');
  parts.push(value.reason || '未取得有效结果');
  return parts.join(' · ');
}

// 此函数不读写 DOM；所有数值为后端启发式诊断，不是准确率。
export function dualFrameViewModel(info = {}, loaded = false, autoFrame = false) {
  const value = info && typeof info === 'object' ? info : {};
  const status = Object.hasOwn(STATUS_LABELS, value.state) ? value.state : 'unavailable';
  const details = [value.reason || '请选择树木和照片'];
  if (Number.isFinite(value.baselineAngle))
    details.push(`基线角 ${value.baselineAngle.toFixed(1)}°`);
  if (Number.isFinite(value.confidence)) details.push(`一致性评分 ${value.confidence.toFixed(2)}`);
  if (Number.isInteger(value.attempts) && value.attempts >= 0) {
    details.push(`辅助帧尝试 ${value.attempts} 次`);
  }
  const frameA = value.frameA && value.frameA !== '-' ? value.frameA : '—';
  const frameB = value.frameB && value.frameB !== '-' ? value.frameB : '—';
  const frameMode = loaded ? (autoFrame ? '（自动）' : '（固定当前帧，换树恢复自动）') : '';
  const attempts = Array.isArray(value.attemptDetails) ? value.attemptDetails : [];
  return {
    status,
    frameMode: !loaded ? 'none' : autoFrame ? 'auto' : 'fixed',
    label: STATUS_LABELS[status],
    reason: details.join(' · '),
    frames: `主帧 A${frameMode}：${frameA} · 辅助帧 B：${frameB}`,
    attempts: attempts.map(describeAttempt),
    showAttempts: Boolean(loaded && attempts.length),
  };
}

export function renderDualFrameInfo(info, loaded, autoFrame, documentRoot = document) {
  const model = dualFrameViewModel(info, loaded, autoFrame);
  const element = (id) => documentRoot.getElementById(id);
  const summary = element('dual-summary');
  summary.dataset.state = model.status;
  summary.dataset.frameMode = model.frameMode;
  element('dual-result').textContent = model.label;
  element('dual-reason').textContent = model.reason;
  element('dual-frames').textContent = model.frames;
  element('dual-diagnostics').hidden = !model.showAttempts;
  element('dual-diagnostics-title').textContent = `查看 ${model.attempts.length} 次辅助帧验证`;
  const list = element('dual-diagnostics-list');
  list.replaceChildren();
  for (const description of model.attempts) {
    const item = documentRoot.createElement('li');
    item.textContent = description;
    list.append(item);
  }
}
