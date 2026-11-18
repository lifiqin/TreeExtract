'use strict';

// 以下方法只读取当前会话，不会使已核查的切图失效。
const READ_ONLY_METHODS = new Set(['defaults', 'state', 'images', 'panorama.image']);

// 协调会话修改、人工确认与云端预览；它不持有图片或用户数据。
class SessionCoordinator {
  constructor() {
    this.busy = false;
    this.previewScope = null;
    this.previewGeneration = 0;
  }

  assertIdle(message = '树种确认进行中，请稍候。') {
    if (this.busy) throw new Error(message);
  }

  beforeBackendCall(method) {
    if (READ_ONLY_METHODS.has(method)) return;
    this.assertIdle('树种确认进行中，请等待完成后再切换树木或切图。');
    this.cancelPreview();
  }

  cancelPreview() {
    this.previewScope = null;
    this.previewGeneration += 1;
  }

  beginPreview() {
    this.assertIdle();
    this.cancelPreview();
    return this.previewGeneration;
  }

  finishPreview(generation, scope) {
    // 快照等待期间若有切树、取消预览或其他确认，不能重新启用旧预览。
    if (this.busy || generation !== this.previewGeneration)
      throw new Error('数据或切图已变化，请重新核查。');
    this.previewScope = scope;
    return scope;
  }

  async runExclusive(action, message) {
    this.assertIdle(message);
    this.busy = true;
    this.previewGeneration += 1;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { SessionCoordinator };
