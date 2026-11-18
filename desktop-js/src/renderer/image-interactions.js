import { createPanDragQueue } from './pan-drag-queue.mjs';
import { sessionTarget } from './session-target.mjs';

// img 使用 contain 时先去掉四周黑边，再把鼠标位置转换成图像坐标。
function imagePoint(image, clientX, clientY) {
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const rect = image.getBoundingClientRect();
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  const x = (clientX - left) / width;
  const y = (clientY - top) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y, width, height } : null;
}

export function setupPhotoInteraction({ element, state, api, execute }) {
  const stage = element('photo-stage');
  const cursor = element('mark-cursor');
  let active = false;

  function showCursor(event) {
    const point = imagePoint(element('photo-image'), event.clientX, event.clientY);
    if (!point) {
      cursor.hidden = true;
      return null;
    }
    const bounds = stage.getBoundingClientRect();
    cursor.style.left = `${event.clientX - bounds.left}px`;
    cursor.style.top = `${event.clientY - bounds.top}px`;
    cursor.hidden = false;
    return point;
  }

  stage.addEventListener('pointerdown', (event) => {
    if (!state.editing || state.busy || event.button !== 0) return;
    if (!showCursor(event)) return;
    active = true;
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (active) showCursor(event);
  });
  stage.addEventListener('pointerup', async (event) => {
    if (!active) return;
    active = false;
    const point = showCursor(event);
    cursor.hidden = true;
    if (point) await execute('正在更新红圈和切图…', () => api.setMark(point.x, point.y));
  });
  stage.addEventListener('pointercancel', () => {
    active = false;
    cursor.hidden = true;
  });
}

export function setupPanoramaInteraction({ element, state, api, execute, showPanorama }) {
  const stage = element('pano-stage');
  const image = element('pano-image');
  const hint = element('pano-hint');
  let drag = null;
  let activePan = null;
  let wheelTimer = null;
  let requestedFov = null;
  let wheelScope = null;

  async function showDecodedPanorama(frame) {
    if (!frame?.panorama) throw new Error('全景帧不可用。');
    const decoded = new Image();
    decoded.src = frame.panorama;
    await decoded.decode();
    showPanorama(frame.panorama);
  }

  function applyWheel() {
    wheelTimer = null;
    if (!state.current?.loaded || sessionTarget(state) !== wheelScope) {
      requestedFov = null;
      return;
    }
    // 拖动或其他操作进行中时推迟缩放，避免把已输入的滚轮操作静默丢弃。
    if (state.busy) {
      wheelTimer = setTimeout(applyWheel, 120);
      return;
    }
    const fov = requestedFov;
    requestedFov = null;
    if (fov !== null) execute('正在调整全景视场…', () => api.pan(0, 0, fov));
  }

  function startRendering(view) {
    if (view.queue || state.busy) return;
    activePan = view;
    view.previewing = true;
    stage.classList.add('drag-preview');
    hint.textContent = '旋转预览中 · 松开后精确更新';
    view.queue = createPanDragQueue({
      startX: view.startX,
      startY: view.startY,
      startPan: view.startPan,
      startTilt: view.startTilt,
      panScale: -view.fov / view.width,
      tiltScale: (view.fov * 0.625) / view.height,
      fov: view.fov,
      pan: (...args) => api.pan(...args),
      images: () => api.panoramaImage(true),
      onFrame: showDecodedPanorama,
    });
    // 手势期间只维护一个在途任务；新的鼠标事件被合并，而不会堆积后台请求。
    execute(
      '正在旋转全景视角…',
      async () => {
        const result = await view.queue.run();
        // 松手后恢复完整分辨率，且最终图像与后端视角一致。
        await showDecodedPanorama(await api.panoramaImage(false));
        return result;
      },
      {
        images: false,
        recoverImages: true,
      },
    )
      .then((result) => {
        if (result === undefined) {
          clearTimeout(wheelTimer);
          wheelTimer = null;
          requestedFov = null;
        }
      })
      .finally(() => {
        if (activePan === view) activePan = null;
        view.previewing = false;
        stage.classList.remove('drag-preview');
        hint.textContent = state.editing ? '点击或拖动至树干位置' : '拖动旋转 · 滚轮缩放';
        if (drag === view) drag = null;
      });
  }

  function updateDrag(view, x, y) {
    view.x = x;
    view.y = y;
    if (!view.queue && Math.abs(x - view.startX) + Math.abs(y - view.startY) >= 3) {
      startRendering(view);
    }
    if (view.queue) {
      view.queue.move(x, y);
    }
  }

  function finishDrag(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const view = drag;
    drag = null;
    const x = event && Number.isFinite(event.clientX) ? event.clientX : view.x;
    const y = event && Number.isFinite(event.clientY) ? event.clientY : view.y;
    if (state.editing) {
      const point = event && imagePoint(image, x, y);
      if (point) execute('正在更新全景红圈…', () => api.setPanoMark(point.x, point.y));
      return;
    }
    updateDrag(view, x, y);
    if (view.queue) view.queue.finish(x, y);
  }

  stage.addEventListener('pointerdown', (event) => {
    if (!state.current?.loaded || state.busy || event.button !== 0) return;
    const point = imagePoint(image, event.clientX, event.clientY);
    if (!point) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      width: point.width,
      height: point.height,
      fov: state.current.viewFov,
      startPan: state.current.viewPan,
      startTilt: state.current.viewTilt,
      queue: null,
      previewing: false,
    };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (drag && event.pointerId === drag.pointerId && !state.editing) {
      updateDrag(drag, event.clientX, event.clientY);
    }
  });
  stage.addEventListener('pointerup', finishDrag);
  stage.addEventListener('pointercancel', () => finishDrag(null));
  stage.addEventListener('lostpointercapture', () => finishDrag(null));
  window.addEventListener('blur', () => finishDrag(null));
  stage.addEventListener(
    'wheel',
    (event) => {
      if (!state.current?.loaded) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      if (state.busy && !activePan) return;
      const nextScope = sessionTarget(state);
      if (wheelScope !== nextScope) requestedFov = null;
      wheelScope = nextScope;
      requestedFov = Math.max(
        20,
        Math.min(140, (requestedFov ?? state.current.viewFov) + (event.deltaY < 0 ? -8 : 8)),
      );
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(applyWheel, 120);
    },
    { passive: false },
  );
}
