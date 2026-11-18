'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../src/renderer/merge-view.mjs');

function makeNode() {
  const listeners = new Map();
  let content = '';
  return {
    children: [],
    dataset: {},
    attributes: {},
    disabled: false,
    hidden: false,
    open: false,
    get textContent() {
      return content + this.children.map((child) => child.textContent).join('');
    },
    set textContent(value) {
      content = String(value);
      this.children = [];
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren() {
      content = '';
      this.children = [];
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    addEventListener(event, handler) {
      const handlers = listeners.get(event) || [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
    async dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) await handler(event);
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function compatible(overrides = {}) {
  return {
    ok: true,
    imageCount: 2,
    metaCount: 2,
    treeCount: 1,
    errors: [],
    warnings: [],
    ...overrides,
  };
}

async function fixture(overrides = {}, loadResult = async () => true) {
  const { createMergeView } = await modulePromise;
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeNode());
    return elements.get(id);
  };
  const calls = { analyzed: [], loaded: [], executed: 0 };
  const api = {
    chooseMergeFolders: async () => ['E:\\capture-a', 'E:\\capture-b'],
    chooseMergeTrees: async () => 'E:\\trees',
    analyzeMerge: async (...args) => {
      calls.analyzed.push(args);
      return compatible();
    },
    executeMerge: async () => {
      calls.executed += 1;
      return { directory: 'E:\\merged', loadable: true };
    },
    ...overrides,
  };
  const settings = {
    element,
    api,
    documentRef: { createElement: makeNode },
    onLoad: async (directory) => {
      calls.loaded.push(directory);
      return loadResult(directory);
    },
  };
  const view = createMergeView(settings);
  view.bind();
  await element('open-merge').dispatch('click');
  const click = (id) => element(id).dispatch('click');
  return { element, click, api, calls };
}

test('文件夹去重、树心选择与移除都会重新要求分析', async () => {
  const f = await fixture();
  assert.equal(f.element('merge-analyze').disabled, true);
  assert.equal(f.element('merge-run').disabled, true);
  await f.click('merge-add');
  f.api.chooseMergeFolders = async () => ['e:\\CAPTURE-A'];
  await f.click('merge-add');
  assert.equal(f.element('merge-folders').children.length, 2);
  await f.click('merge-tree-choose');
  await f.click('merge-analyze');
  assert.deepEqual(f.calls.analyzed[0], [['E:\\capture-a', 'E:\\capture-b'], 'E:\\trees']);
  assert.equal(f.element('merge-run').disabled, false);
  await f.click('merge-tree-clear');
  assert.equal(f.element('merge-run').disabled, true);
  await f.click('merge-analyze');
  await f.element('merge-folders').children[0].children[1].dispatch('click');
  assert.equal(f.element('merge-folders').children.length, 1);
  assert.equal(f.element('merge-analyze').disabled, true);
  assert.equal(f.element('merge-run').disabled, true);
});

test('分析期间禁用修改与关闭；不兼容结果不启用合并', async () => {
  const pending = deferred();
  const f = await fixture({ analyzeMerge: () => pending.promise });
  await f.click('merge-add');
  const running = f.click('merge-analyze');
  assert.equal(f.element('merge-close').disabled, true);
  assert.equal(f.element('merge-add').disabled, true);
  assert.equal(f.element('merge-run').disabled, true);
  await f.click('merge-close');
  assert.equal(f.element('merge-dialog').open, true);
  let cancelled = false;
  await f.element('merge-dialog').dispatch('cancel', { preventDefault: () => (cancelled = true) });
  assert.equal(cancelled, true);
  pending.resolve(compatible({ ok: false, errors: ['different coordinates'] }));
  await running;
  assert.equal(f.element('merge-close').disabled, false);
  assert.equal(f.element('merge-add').disabled, false);
  assert.equal(f.element('merge-run').disabled, true);
  assert.equal(f.element('merge-result').dataset.kind, 'error');
  assert.match(f.element('merge-result').textContent, /different coordinates/);
});

test('分析失败或返回无法展示的结果均解除忙状态，不保留可执行的旧分析', async () => {
  const f = await fixture();
  await f.click('merge-add');
  await f.click('merge-analyze');
  for (const analyze of [
    async () => {
      throw new Error('invalid data');
    },
    async () => ({ ok: true, imageCount: 2 }),
  ]) {
    f.api.analyzeMerge = analyze;
    await f.click('merge-analyze');
    assert.equal(f.element('merge-run').disabled, true);
    assert.equal(f.element('merge-close').disabled, false);
    assert.equal(f.element('merge-result').dataset.kind, 'error');
  }
});

test('取消输出位置保留通过的分析，合并成功后加载独立输出目录', async () => {
  const f = await fixture({ executeMerge: async () => null });
  await f.click('merge-add');
  await f.click('merge-analyze');
  await f.click('merge-run');
  assert.equal(f.element('merge-run').disabled, false);
  assert.equal(f.element('merge-result').dataset.kind, 'success');
  assert.deepEqual(f.calls.loaded, []);
  f.api.executeMerge = async () => ({ directory: 'E:\\merged', loadable: true });
  await f.click('merge-run');
  assert.deepEqual(f.calls.loaded, ['E:\\merged']);
  assert.equal(f.element('merge-run').disabled, true);
  assert.match(f.element('merge-result').textContent, /已在软件中加载/);
});

test('无树心结果不自动加载；合并异常后需要重新分析', async () => {
  const f = await fixture({
    executeMerge: async () => ({ directory: 'E:\\images', loadable: false }),
  });
  await f.click('merge-add');
  await f.click('merge-analyze');
  await f.click('merge-run');
  assert.deepEqual(f.calls.loaded, []);
  assert.match(f.element('merge-result').textContent, /暂不能加载树列表/);
  await f.click('merge-analyze');
  f.api.executeMerge = async () => {
    throw new Error('archive failed');
  };
  await f.click('merge-run');
  assert.equal(f.element('merge-result').textContent, 'archive failed');
  assert.equal(f.element('merge-result').dataset.kind, 'error');
  assert.equal(f.element('merge-run').disabled, true);
  assert.equal(f.element('merge-close').disabled, false);
});

test('自动加载结束前保持忙状态；加载未完成时保留输出路径并提示手动选择', async () => {
  const pending = deferred();
  const f = await fixture({}, () => pending.promise);
  await f.click('merge-add');
  await f.click('merge-analyze');
  const running = f.click('merge-run');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.element('merge-close').disabled, true);
  assert.equal(f.element('merge-analyze').disabled, true);
  assert.deepEqual(f.calls.loaded, ['E:\\merged']);
  pending.resolve(false);
  await running;
  assert.equal(f.element('merge-close').disabled, false);
  assert.equal(f.element('merge-run').disabled, true);
  assert.equal(f.element('merge-result').dataset.kind, 'error');
  assert.match(f.element('merge-result').textContent, /E:\\merged/);
  assert.match(f.element('merge-result').textContent, /自动加载未完成/);
});

test('目录选择取消不清空已有分析，目录选择错误不锁住窗口', async () => {
  const f = await fixture();
  await f.click('merge-add');
  await f.click('merge-analyze');
  f.api.chooseMergeFolders = async () => [];
  f.api.chooseMergeTrees = async () => null;
  await f.click('merge-add');
  await f.click('merge-tree-choose');
  assert.equal(f.element('merge-run').disabled, false);
  f.api.chooseMergeFolders = async () => {
    throw new Error('dialog failed');
  };
  await f.click('merge-add');
  assert.equal(f.element('merge-result').textContent, 'dialog failed');
  assert.equal(f.element('merge-result').dataset.kind, 'error');
  assert.equal(f.element('merge-close').disabled, false);
});

test('自动加载抛错时保留错误原因并解除忙状态，不能继续使用旧分析', async () => {
  const f = await fixture({}, async () => {
    throw new Error('load failed');
  });
  await f.click('merge-add');
  await f.click('merge-analyze');
  await f.click('merge-run');
  assert.deepEqual(f.calls.loaded, ['E:\\merged']);
  assert.equal(f.element('merge-result').textContent, 'load failed');
  assert.equal(f.element('merge-result').dataset.kind, 'error');
  assert.equal(f.element('merge-run').disabled, true);
  assert.equal(f.element('merge-close').disabled, false);
});
