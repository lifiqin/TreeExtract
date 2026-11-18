// 取景距离和风险提示只负责展示后端结果，不改变选帧或定位算法。
export function photoMetadataViewModel(value = {}) {
  const current = value && typeof value === 'object' ? value : {};
  const distance = Number.isFinite(current.cameraHorizontalDistance)
    ? current.cameraHorizontalDistance
    : null;
  const source = current.distanceUsesTrunkAxis === true ? '树干' : '树心';
  const distanceText = distance === null ? '—' : `${distance.toFixed(2)} m（${source}）`;
  // 无可靠目标时不能把上一帧残留角度呈现为当前结果。
  const validTarget = current.loaded && current.targetValid === true;
  const bearingText =
    validTarget && Number.isFinite(current.bearing) ? `${current.bearing.toFixed(1)}°` : '—';
  const elevationText =
    validTarget && Number.isFinite(current.elevation) ? `${current.elevation.toFixed(1)}°` : '—';
  const details = current.loaded
    ? `方位 ${bearingText} · 水平距离 ${distanceText} · 仰角 ${elevationText}`
    : '方位 — · 水平距离 — · 仰角 —';
  const tooClose = current.frameStrategy === 'nearest' && distance !== null && distance < 2.5;
  const nearestWarning = tooClose
    ? `当前帧水平距离仅 ${distance.toFixed(2)} m，可能过近、遮挡或拍入拍摄者；建议切回“优质近帧”。`
    : '';
  const selectionWarning =
    current.loaded && typeof current.frameSelectionWarning === 'string'
      ? current.frameSelectionWarning
      : '';
  const warning = [nearestWarning, selectionWarning].filter(Boolean).join(' ');
  // 几何先验不等于人像检测，不能由界面推断“无人”。
  const risk = current.photoRisk || {};
  return {
    details,
    warning,
    showRisk: Boolean(current.loaded && risk.reason),
    riskState: risk.state || 'unavailable',
    riskReason: current.loaded ? risk.reason || '' : '',
  };
}

export function renderPhotoMetadata(value, documentRoot = document) {
  const model = photoMetadataViewModel(value);
  const element = (id) => documentRoot.getElementById(id);
  element('photo-details').textContent = model.details;
  const warning = element('distance-warning');
  warning.hidden = !model.warning;
  warning.textContent = model.warning;
  const note = element('photo-risk-note');
  note.hidden = !model.showRisk;
  note.dataset.state = model.riskState;
  note.textContent = model.riskReason;
}
