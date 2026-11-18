'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../src/renderer/table-view.mjs');

function node() {
  return {
    children: [],
    handlers: {},
    append(child) {
      this.children.push(child);
    },
    replaceChildren(fragment) {
      this.children = fragment.children.slice();
    },
    addEventListener(name, handler) {
      this.handlers[name] = handler;
    },
  };
}

function fixture() {
  const body = node();
  const search = { value: '' };
  const count = { textContent: '' };
  let closed = 0;
  const dialog = {
    close: () => {
      closed += 1;
    },
  };
  const elements = {
    'table-body': body,
    'table-search': search,
    'table-count': count,
    'table-dialog': dialog,
  };
  const documentRef = { createElement: node, createDocumentFragment: node };
  const state = {
    table: [
      { id: 92, height: 5.08, frame: '<frame>.jpg', distance: 3.456, bearing: 20, offset: 1 },
      { id: 93, height: 4.1, frame: 'other.jpg', distance: 7, bearing: 30, offset: 2 },
    ],
  };
  const selected = [];
  const api = {
    selectTableRow: async (id) => {
      selected.push(id);
    },
  };
  const execute = async (_message, action) => action();
  return {
    body,
    search,
    count,
    state,
    documentRef,
    element: (id) => elements[id],
    api,
    execute,
    selected,
    closed: () => closed,
  };
}

test('对照表按树号或帧名筛选，并以文本显示数据', async () => {
  const { createTableView } = await modulePromise;
  const f = fixture();
  const view = createTableView(f);
  view.render();
  assert.equal(f.count.textContent, '2 / 2 条');
  assert.equal(f.body.children[0].children[1].textContent, '5.08');
  assert.equal(f.body.children[0].children[2].textContent, '<frame>.jpg');
  assert.equal(f.body.children[0].children[3].textContent, '3.46');
  f.search.value = 'OTHER';
  view.render();
  assert.equal(f.count.textContent, '1 / 2 条');
  assert.equal(f.body.children[0].children[0].textContent, 93);
  f.search.value = '92';
  view.render();
  assert.equal(f.body.children[0].children[0].textContent, 92);
});

test('双击和回车使用所选树号，并关闭对照表', async () => {
  const { createTableView } = await modulePromise;
  const f = fixture();
  createTableView(f).render();
  await f.body.children[0].handlers.dblclick();
  f.body.children[1].handlers.keydown({ key: 'Escape' });
  f.body.children[1].handlers.keydown({ key: 'Enter' });
  await Promise.resolve();
  assert.deepEqual(f.selected, [92, 93]);
  assert.equal(f.closed(), 2);
});
