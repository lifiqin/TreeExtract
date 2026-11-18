// 全景渲染只能串行进行：保留最新指针位置，合并途中产生的事件，避免请求积压。
export function createPanDragQueue({
  startX,
  startY,
  startPan,
  startTilt,
  panScale,
  tiltScale,
  fov,
  pan,
  images,
  onFrame,
}) {
  let latestX = startX;
  let latestY = startY;
  let sentX = startX;
  let sentY = startY;
  let currentPan = startPan;
  let currentTilt = startTilt;
  let finished = false;
  let wake = null;

  function signal() {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  }

  return {
    move(x, y) {
      if (finished) return;
      latestX = x;
      latestY = y;
      signal();
    },
    finish(x, y) {
      if (finished) return;
      latestX = x;
      latestY = y;
      finished = true;
      signal();
    },
    async run() {
      let result;
      while (true) {
        if (latestX !== sentX || latestY !== sentY) {
          const frameX = latestX;
          const frameY = latestY;
          // 以起始视角计算目标，避免上下拖过俯仰限位后再拉回时累计误差。
          const targetPan = (((startPan + (frameX - startX) * panScale) % 360) + 360) % 360;
          const targetTilt = Math.max(-89, Math.min(89, startTilt + (frameY - startY) * tiltScale));
          const panDelta = ((targetPan - currentPan + 540) % 360) - 180;
          const tiltDelta = targetTilt - currentTilt;
          sentX = frameX;
          sentY = frameY;
          result = await pan(panDelta, tiltDelta, fov);
          currentPan = Number.isFinite(result?.viewPan) ? result.viewPan : targetPan;
          currentTilt = Number.isFinite(result?.viewTilt) ? result.viewTilt : targetTilt;
          const frame = await images();
          // 等待解码并显示后才处理下一帧，避免旧图异步解码与新视角错位。
          await onFrame(frame, frameX, frameY);
        } else if (finished) {
          return result;
        } else {
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      }
    },
  };
}
