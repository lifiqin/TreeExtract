'use strict';

// Pure validation and edit rules for the offline, prediction-free review UI.
const REVIEW_METHODS = new Set(['blind', 'prediction_visible']);
const LABEL_KEYS = new Set([
  'sampleId',
  'treeId',
  'frameA',
  'imageSha256',
  'width',
  'height',
  'reviewer',
  'reviewMethod',
  'targetVisible',
  'trunkCenter',
  'personVisible',
  'headVisible',
  'scalpVisible',
  'pair',
]);
const EDITABLE_KEYS = new Set([
  'targetVisible',
  'trunkCenter',
  'personVisible',
  'headVisible',
  'scalpVisible',
]);

function fail(message) {
  throw new Error(message);
}

function nullableBoolean(value, name) {
  if (value !== null && typeof value !== 'boolean') fail(`${name} 必须为是、否或未知`);
}

function hasPrimaryReview(label) {
  return (
    label.targetVisible !== null ||
    label.trunkCenter !== null ||
    label.personVisible !== null ||
    label.headVisible !== null ||
    label.scalpVisible !== null
  );
}

function hasReview(label) {
  return hasPrimaryReview(label) || label.pair !== null;
}

function validateLabel(label, dataset) {
  if (!label || typeof label !== 'object' || Array.isArray(label)) fail('标注记录格式不正确');
  if (
    Object.keys(label).some((key) => !LABEL_KEYS.has(key)) ||
    [...LABEL_KEYS].some((key) => !Object.hasOwn(label, key))
  )
    fail('标注记录字段不匹配');
  if ('predictedPoint' in label || 'peoplePrediction' in label || 'dualDiagnostics' in label) {
    fail('标注文件包含预测信息，不允许在盲标页面中打开');
  }
  const prefix = dataset + ':';
  const suffix =
    typeof label.sampleId === 'string' && label.sampleId.startsWith(prefix)
      ? label.sampleId.slice(prefix.length)
      : '';
  if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) fail('样本序号无效');
  if (!Number.isSafeInteger(label.treeId) || typeof label.frameA !== 'string')
    fail('树号或帧名无效');
  if (label.imageSha256 === null) {
    if (label.width !== null || label.height !== null) fail('缺失照片的画幅必须为空');
    if (hasReview(label)) fail('缺失照片不能标注');
  } else {
    if (typeof label.imageSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(label.imageSha256))
      fail('照片 SHA-256 无效');
    if (
      !Number.isSafeInteger(label.width) ||
      label.width <= 0 ||
      !Number.isSafeInteger(label.height) ||
      label.height <= 0 ||
      !label.frameA
    )
      fail('照片尺寸或帧名无效');
  }
  for (const name of ['targetVisible', 'personVisible', 'headVisible', 'scalpVisible'])
    nullableBoolean(label[name], name);
  if (label.trunkCenter !== null) {
    const p = label.trunkCenter;
    if (
      !p ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      p.x < 0 ||
      p.x > 1 ||
      p.y < 0 ||
      p.y > 1
    )
      fail('树干标注坐标无效');
    if (label.targetVisible !== true) fail('树干坐标要求目标可见');
  }
  if (label.headVisible === true && label.personVisible === false) fail('头部可见与无人互相矛盾');
  if (label.scalpVisible === true && (label.personVisible === false || label.headVisible === false))
    fail('头皮可见与人体/头部不可见互相矛盾');
  if (hasPrimaryReview(label)) {
    if (typeof label.reviewer !== 'string' || !label.reviewer.trim())
      fail('已标注内容需要标注者代号');
    if (!REVIEW_METHODS.has(label.reviewMethod)) fail('已标注内容需要选择盲标或看过预测');
  }
  return label;
}

function validateDocument(document) {
  if (
    !document ||
    document.schema !== 'treeextract.labels.v1' ||
    !Array.isArray(document.labels) ||
    typeof document.dataset !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(document.dataset) ||
    Object.keys(document).some((key) => !['schema', 'dataset', 'labels'].includes(key))
  )
    fail('请选择验收标注模板，而不是预测文件');
  if (document.labels.length > 5000) fail('一次最多标注 5000 张照片');
  const seen = new Set();
  for (const label of document.labels) {
    validateLabel(label, document.dataset);
    if (seen.has(label.sampleId)) fail('标注文件有重复样本');
    seen.add(label.sampleId);
  }
  return document;
}

function sampleFileName(label, dataset) {
  validateLabel(label, dataset);
  return label.sampleId.slice(dataset.length + 1).padStart(6, '0') + '-clean.jpg';
}

async function verifyImage(bytes, width, height, label) {
  if (!globalThis.crypto?.subtle) fail('本地 SHA-256 不可用，无法核验照片');
  if (width !== label.width || height !== label.height) fail('照片尺寸与标注模板不一致');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (
    data.length < 4 ||
    data.length > 64 * 1024 * 1024 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data[data.length - 1] !== 0xd9
  )
    fail('照片不是完整 JPEG');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  const actual = Array.from(new Uint8Array(digest), (item) =>
    item.toString(16).padStart(2, '0'),
  ).join('');
  if (actual !== label.imageSha256) fail('照片 SHA-256 与标注模板不一致');
  return true;
}

function applyReview(label, dataset, changes, reviewer, reviewMethod) {
  if (!label.imageSha256) fail('缺失照片不能标注');
  if (typeof reviewer !== 'string' || !reviewer.trim()) fail('请先填写标注者代号');
  if (!REVIEW_METHODS.has(reviewMethod)) fail('请选择标注方式');
  if (label.pair !== null && reviewMethod === 'blind')
    fail('已进行双帧候选复核，继续修改主帧请标为看过预测');
  if (
    !changes ||
    typeof changes !== 'object' ||
    Array.isArray(changes) ||
    Object.keys(changes).some((key) => !EDITABLE_KEYS.has(key))
  )
    fail('不能修改样本身份或图像证据');
  const next = { ...label, ...changes, reviewer: reviewer.trim(), reviewMethod };
  validateLabel(next, dataset);
  return next;
}

function normalizedPoint(clientX, clientY, bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) fail('图片尺寸无效');
  const x = (clientX - bounds.left) / bounds.width;
  const y = (clientY - bounds.top) / bounds.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)
    fail('请点击照片范围内');
  return { x, y };
}

function validatePairPrediction(sample, label, dataset) {
  validateLabel(label, dataset);
  const evidence = sample && sample.dualEvidence;
  const dual = sample && sample.dualDiagnostics;
  if (
    !sample ||
    sample.sampleId !== label.sampleId ||
    sample.treeId !== label.treeId ||
    sample.frameA !== label.frameA ||
    !sample.image ||
    sample.image.sha256 !== label.imageSha256 ||
    sample.image.width !== label.width ||
    sample.image.height !== label.height ||
    !Number.isSafeInteger(sample.treeIndex) ||
    sample.sampleId !== `${dataset}:${sample.treeIndex}` ||
    !sample.dual ||
    sample.dual.state !== 'success' ||
    !dual ||
    dual.state !== 'success' ||
    !evidence ||
    evidence.state !== 'available' ||
    evidence.treeId !== sample.treeId ||
    evidence.treeIndex !== sample.treeIndex ||
    evidence.frameA !== sample.frameA ||
    evidence.frameA !== dual.frameA ||
    evidence.frameB !== dual.frameB ||
    evidence.frameB !== sample.dual.frameB ||
    !evidence.frameB ||
    evidence.frameA === evidence.frameB ||
    evidence.attempt !== dual.attempts ||
    !Number.isSafeInteger(evidence.attempt) ||
    evidence.attempt <= 0 ||
    evidence.hashFormat !== 'sha256-wh32le-topdown-bgra32-v1'
  )
    fail('双帧证据与当前树、帧或尝试次数不一致');
  for (const [letter, key] of [
    ['A', 'observationA'],
    ['B', 'observationB'],
  ]) {
    const observation = evidence[key],
      clean = evidence.images && evidence.images['pano' + letter];
    if (
      !observation ||
      !clean ||
      observation.frame !== evidence['frame' + letter] ||
      observation.width !== clean.width ||
      observation.height !== clean.height ||
      !/^[0-9a-f]{64}$/.test(observation.analysisPixelSha256 || '') ||
      observation.analysisPixelSha256 !== clean.pixelSha256
    )
      fail('观测图像与分析哈希不一致');
    for (const field of [
      'azimuthDeg',
      'elevationTopDeg',
      'elevationBottomDeg',
      'widthDeg',
      'azimuthOriginDeg',
      'verticalCalibrationDeg',
      'x',
      'yTop',
      'yBottom',
    ]) {
      if (!Number.isFinite(observation[field])) fail('双帧候选坐标无效');
    }
    if (
      observation.widthDeg <= 0 ||
      observation.x < 0 ||
      observation.x > 1 ||
      observation.yTop < 0 ||
      observation.yBottom > 1 ||
      observation.yTop > observation.yBottom
    ) {
      fail('双帧候选位置超出画幅');
    }
  }
  for (const letter of ['A', 'B']) {
    const clean = evidence.images['pano' + letter],
      marked = evidence.images['pano' + letter + 'Marked'];
    if (
      clean.width !== marked.width ||
      clean.height !== marked.height ||
      clean.pixelSha256 === marked.pixelSha256
    ) {
      fail('双帧候选标记图与原图不匹配');
    }
  }
  for (const key of ['panoA', 'panoAMarked', 'panoB', 'panoBMarked']) {
    const image = evidence.images && evidence.images[key];
    const expectedName = `${String(sample.treeIndex).padStart(6, '0')}-${key}.png`;
    if (
      !image ||
      image.path !== `pairs/${expectedName}` ||
      !/^[0-9a-f]{64}$/.test(image.fileSha256 || '') ||
      !/^[0-9a-f]{64}$/.test(image.pixelSha256 || '') ||
      !Number.isSafeInteger(image.width) ||
      image.width <= 0 ||
      !Number.isSafeInteger(image.height) ||
      image.height <= 0
    )
      fail('双帧图像证据字段无效');
  }
  return evidence;
}

async function verifyPairImage(bytes, width, height, image) {
  if (!globalThis.crypto?.subtle) fail('本地 SHA-256 不可用，无法核验图证');
  if (width !== image.width || height !== image.height) fail('双帧图证尺寸不一致');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    data.length < 45 ||
    data.length > 64 * 1024 * 1024 ||
    !signature.every((value, index) => data[index] === value)
  )
    fail('双帧图证不是 PNG');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  const actual = Array.from(new Uint8Array(digest), (item) =>
    item.toString(16).padStart(2, '0'),
  ).join('');
  if (actual !== image.fileSha256) fail('双帧图证 SHA-256 不一致');
  return true;
}

function applyPairReview(label, dataset, evidence, answers, reviewer) {
  validateLabel(label, dataset);
  if (!evidence || evidence.state !== 'available') fail('缺少实际胜出候选图证');
  if (!answers || typeof answers !== 'object') fail('双帧复核内容无效');
  nullableBoolean(answers.sameTree, 'sameTree');
  nullableBoolean(answers.bothAreTarget, 'bothAreTarget');
  if (answers.sameTree === null && answers.bothAreTarget === null) fail('没有判断时请保持未知');
  if (answers.bothAreTarget === true && answers.sameTree !== true)
    fail('两个候选都是目标树时必须确认同树');
  if (answers.candidateVisible !== true) fail('请先确认两帧候选线框均可辨认');
  if (typeof reviewer !== 'string' || !reviewer.trim()) fail('请填写双帧复核者代号');
  const result = {
    ...label,
    pair: {
      frameA: evidence.frameA,
      frameB: evidence.frameB,
      attempt: evidence.attempt,
      sameTree: answers.sameTree,
      bothAreTarget: answers.bothAreTarget,
      candidateVisible: true,
      markedASha256: evidence.images.panoAMarked.fileSha256,
      markedBSha256: evidence.images.panoBMarked.fileSha256,
      reviewer: reviewer.trim(),
      reviewMethod: 'candidate_visible',
    },
  };
  validatePairLabel(result, evidence);
  return result;
}

function validatePairLabel(label, evidence) {
  const pair = label.pair;
  if (pair === null) return;
  if (
    !pair ||
    typeof pair !== 'object' ||
    Array.isArray(pair) ||
    !evidence ||
    evidence.state !== 'available'
  ) {
    fail('双帧复核缺少证据');
  }
  nullableBoolean(pair.sameTree, 'sameTree');
  nullableBoolean(pair.bothAreTarget, 'bothAreTarget');
  if (pair.sameTree === null && pair.bothAreTarget === null) fail('双帧复核没有判断');
  if (pair.bothAreTarget === true && pair.sameTree !== true) fail('双帧复核结果互相矛盾');
  if (
    pair.frameA !== evidence.frameA ||
    pair.frameB !== evidence.frameB ||
    pair.attempt !== evidence.attempt ||
    pair.markedASha256 !== evidence.images.panoAMarked.fileSha256 ||
    pair.markedBSha256 !== evidence.images.panoBMarked.fileSha256 ||
    pair.candidateVisible !== true ||
    pair.reviewMethod !== 'candidate_visible' ||
    typeof pair.reviewer !== 'string' ||
    !pair.reviewer.trim()
  ) {
    fail('双帧复核与候选图证或复核者不一致');
  }
}

const TreeAnnotationCore = Object.freeze({
  hasReview,
  hasPrimaryReview,
  validateLabel,
  validateDocument,
  sampleFileName,
  verifyImage,
  applyReview,
  normalizedPoint,
  validatePairPrediction,
  verifyPairImage,
  applyPairReview,
  validatePairLabel,
});
if (typeof module !== 'undefined' && module.exports) module.exports = TreeAnnotationCore;
else globalThis.TreeAnnotationCore = TreeAnnotationCore;
