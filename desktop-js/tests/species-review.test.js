'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  analyzeSpecies,
  candidate,
  hierarchicalCandidate,
  catalog,
  ENDPOINT,
} = require('../src/species-cloud');
const { identity, readSpecies, saveSpecies, recordRevision } = require('../src/species-store');
const { scopeOf } = require('../src/species-scope');

const key = 'test-placeholder-key';
const image = 'data:image/jpeg;base64,/9j/2Q==';
const localText = '本地候选：香樟 60%';

function reply(value, status = 200) {
  return {
    ok: status === 200,
    status,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
      }),
  };
}

test('提供的七组目录保留 119 项和原始标识，不强制映射模型 slug', () => {
  assert.equal(catalog.length, 7);
  assert.equal(catalog.flatMap((group) => group.entries).length, 119);
  assert.deepEqual(candidate('zhangshu'), { value: 'zhangshu', name: '香樟' });
  assert.equal(candidate('xiangzhang'), null);
  assert.equal(candidate('luoyushan'), null);
  assert.deepEqual(hierarchicalCandidate('zhangshu', '常绿乔木'), {
    value: 'zhangshu',
    name: '香樟',
    group: '常绿乔木',
  });
  assert.equal(hierarchicalCandidate('zhangshu', '落叶乔木'), null);
});

test('视觉请求独立于本地结果，综合请求只发送文字，且结果不会泄漏密钥', async () => {
  const requests = [];
  const result = await analyzeSpecies({
    key,
    image,
    localText,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body, authorization: options.headers.Authorization });
      return requests.length === 1
        ? reply({ value: 'zhangshu', reason: `视觉特征 ${key}`, uncertainty: '仅见树皮' })
        : reply({
            suggestedValue: 'zhangshu',
            opinion: '可能是香樟',
            differences: '无',
            uncertainty: '缺少叶片',
          });
    },
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url === ENDPOINT));
  assert.equal(requests[0].authorization, `Bearer ${key}`);
  assert.equal(JSON.stringify(requests[0].body).includes(localText), false);
  assert.equal(JSON.stringify(requests[0].body).includes(image), true);
  assert.equal(JSON.stringify(requests[1].body).includes(image), false);
  assert.equal(JSON.stringify(requests[1].body).includes(localText), true);
  assert.equal(JSON.stringify(requests.map((r) => r.body)).includes(key), false);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(result.visual.candidate.name, '香樟');
  assert.equal(result.synthesis.candidate.name, '香樟');
});

test('目录外候选和近缘 slug 不被转为其他物种', async () => {
  let count = 0;
  const result = await analyzeSpecies({
    key,
    image,
    localText,
    fetchImpl: async () =>
      ++count === 1
        ? reply({ value: 'luoyushan', reason: '树皮', uncertainty: '不确定' })
        : reply({ suggestedValue: 'xiangzhang', opinion: '无法确定' }),
  });
  assert.equal(result.visual.candidate, null);
  assert.equal(result.synthesis.candidate, null);
});

test('视觉和综合结果的分组与条目冲突时保持不确定，不强制修正', async () => {
  let count = 0;
  const result = await analyzeSpecies({
    key,
    image,
    localText,
    fetchImpl: async () =>
      ++count === 1
        ? reply({ group: '落叶乔木', value: 'zhangshu' })
        : reply({ suggestedGroup: '落叶乔木', suggestedValue: 'zhangshu' }),
  });
  assert.equal(result.visual.candidate, null);
  assert.equal(result.synthesis.candidate, null);
});

test('综合请求失败时保留视觉结果，不伪装成完整结论', async () => {
  let count = 0;
  const result = await analyzeSpecies({
    key,
    image,
    localText,
    fetchImpl: async () => (++count === 1 ? reply({ value: 'zhangshu' }) : reply({}, 503)),
  });
  assert.equal(result.visual.candidate.name, '香樟');
  assert.equal(result.synthesis, null);
  assert.match(result.synthesisError, /不可用/);
});

test('未经有效输入不能请求网络，网络异常不回显敏感异常', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    throw new Error(`secret ${key}`);
  };
  await assert.rejects(analyzeSpecies({ key: '', image, localText, fetchImpl }));
  await assert.rejects(analyzeSpecies({ key, image: 'https://invalid', localText, fetchImpl }));
  await assert.rejects(analyzeSpecies({ key, image, localText: '', fetchImpl }));
  assert.equal(count, 0);
  await assert.rejects(
    analyzeSpecies({ key, image, localText, fetchImpl }),
    (error) => !error.message.includes(key),
  );
  await assert.rejects(
    analyzeSpecies({
      key,
      image,
      localText,
      fetchImpl: async () => {
        throw new Error(`云端 ${key}`);
      },
    }),
    (error) => !error.message.includes(key),
  );
  assert.equal(count, 1);
});

function snapshot(root, overrides = {}) {
  return {
    dataDir: root,
    datasetFingerprint: 'c'.repeat(64),
    treeId: 10,
    treeIndex: 1,
    imageSha256: 'a'.repeat(64),
    frame: 'photo.jpg',
    ...overrides,
  };
}

test('人工确认原子独立保存、可重读及更新，不写入数据目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'species-test-'));
  const data = path.join(root, 'data');
  const store = path.join(root, 'store');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'original.txt'), 'original');
  const snap = snapshot(data);
  assert.equal(await readSpecies(store, snap), null);
  const saved = await saveSpecies(store, snap, {
    scope: scopeOf(snap),
    value: 'zhangshu',
  });
  assert.equal(saved.record.confirmedBy, 'human');
  await assert.rejects(
    saveSpecies(store, snap, { scope: scopeOf(snap), value: 'elm' }, { expectedRevision: null }),
    /其他实例修改/,
  );
  assert.equal((await readSpecies(store, snap)).choice.name, '香樟');
  assert.deepEqual(await fs.readdir(data), ['original.txt']);
  assert.equal(await fs.readFile(path.join(data, 'original.txt'), 'utf8'), 'original');
  const updated = await saveSpecies(
    store,
    snap,
    { scope: scopeOf(snap), value: '__uncertain__' },
    {
      expectedRevision: recordRevision(saved.record),
    },
  );
  assert.equal((await readSpecies(store, snap)).choice.name, '不确定');
  assert.equal(JSON.parse(await fs.readFile(updated.backupPath, 'utf8')).choice.name, '香樟');
  assert.equal((await fs.readdir(store)).length, 2);
  assert.equal(await readSpecies(store, snapshot(data, { treeId: 11 })), null);
  assert.equal(
    await readSpecies(store, snapshot(data, { datasetFingerprint: 'd'.repeat(64) })),
    null,
  );
  assert.notEqual(identity(snap).dataset, identity(snapshot(path.join(root, 'other'))).dataset);
});

test('切图变更、非法树种、损坏记录和并发锁均拒绝覆盖', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'species-deny-'));
  const data = path.join(root, 'data');
  const store = path.join(root, 'store');
  await fs.mkdir(data);
  const snap = snapshot(data);
  await assert.rejects(
    saveSpecies(store, snap, {
      scope: { ...scopeOf(snap), imageSha256: 'b'.repeat(64) },
      value: 'zhangshu',
    }),
  );
  for (const changed of [
    { treeId: 11 },
    { treeIndex: 2 },
    { frame: 'other.jpg' },
    { datasetFingerprint: 'd'.repeat(64) },
  ]) {
    await assert.rejects(
      saveSpecies(store, snap, { scope: { ...scopeOf(snap), ...changed }, value: 'zhangshu' }),
    );
  }
  await assert.rejects(saveSpecies(store, snap, { scope: scopeOf(snap), value: 'xiangzhang' }));
  await assert.rejects(
    saveSpecies(store, snap, { scope: scopeOf(snap), value: '__other__', otherName: '' }),
  );
  const saved = await saveSpecies(store, snap, {
    scope: scopeOf(snap),
    value: '__other__',
    otherName: '其他树',
  });
  await fs.writeFile(saved.path, 'invalid user data');
  await assert.rejects(saveSpecies(store, snap, { scope: scopeOf(snap), value: 'zhangshu' }));
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'invalid user data');
  await fs.writeFile(`${saved.path}.lock`, 'locked', { flag: 'wx' });
  await assert.rejects(saveSpecies(store, snap, { scope: scopeOf(snap), value: 'zhangshu' }));
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'invalid user data');
});

test('干净切图摘要变化即清旧建议，未保存草稿仅在完全相同身份下恢复', async () => {
  const { createSpeciesReview } = await import('../src/renderer/species-review.mjs');
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: '',
        checked: false,
        hidden: false,
        textContent: '',
        handlers: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, callback) {
          this.handlers[name] = callback;
        },
      });
    return nodes.get(id);
  };
  let current = { loaded: true, dataDir: 'data', treeIndex: 1, treeId: 10, frame: 'a.jpg' };
  let context = { scope: { treeId: 10, imageSha256: 'one' }, record: null };
  const reviewState = { current, sessionGeneration: 1 };
  const review = createSpeciesReview({
    element,
    state: reviewState,
    api: { speciesContext: async () => context },
    execute: async () => {},
  });
  await review.update(current, 'same-marked-image');
  element('species-choice').value = 'elm';
  element('species-choice').handlers.change();
  element('species-visual').textContent = 'old recommendation';
  context = { scope: { treeId: 10, imageSha256: 'two' }, record: null };
  await review.update(current, 'same-marked-image');
  assert.match(element('species-visual').textContent, /尚未请求/);
  assert.equal(element('species-choice').value, '');
  current = { ...current, treeIndex: 2, treeId: 20 };
  context = { scope: { treeId: 20, imageSha256: 'one' }, record: null };
  review.onState(current);
  await review.update(current, 'same-marked-image');
  assert.equal(element('species-choice').value, '');
  current = { ...current, treeIndex: 1, treeId: 10 };
  context = { scope: { treeId: 10, imageSha256: 'one' }, record: null };
  review.onState(current);
  await review.update(current, 'same-marked-image');
  assert.equal(element('species-choice').value, 'elm');
  element('species-visual').textContent = 'old recommendation';
  reviewState.sessionGeneration += 1;
  review.onState(current);
  assert.match(element('species-visual').textContent, /尚未请求/);
});
