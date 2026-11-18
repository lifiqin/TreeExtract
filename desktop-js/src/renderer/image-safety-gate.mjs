// 仅阻挡模型已检出的画面；未检出或不可用不能解释为画面安全。
// 用户的查看确认只适用于完全相同的数据，不能沿用到下一张图片。
export class ImageSafetyGate {
  constructor() {
    this.pending = null;
    this.approved = null;
  }

  update(image, detection) {
    const detected =
      detection?.status === 'complete' &&
      (detection.personDetected === true || detection.headDetected === true);
    if (!image || !detected) {
      this.pending = null;
      this.approved = null;
      return { image: image || null, blocked: false };
    }
    if (this.approved === image) return { image, blocked: false };
    this.pending = image;
    this.approved = null;
    return { image: null, blocked: true };
  }

  reveal() {
    if (!this.pending) return null;
    const image = this.pending;
    this.approved = image;
    this.pending = null;
    return image;
  }
}
