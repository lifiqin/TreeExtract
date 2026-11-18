'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../src/renderer/tree-list-view.mjs');

function makeNode(tag = 'div') {
  return {
    tag,
    children: [],
    dataset: {},
    attributes: {},
    textContent: '',
    className: '',
    scrollTop: 0,
    replacements: 0,
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(fragment) {
      this.children = fragment.children.slice();
      this.replacements += 1;
    },
    querySelector(selector) {
      return selector === '.tree-row.selected'
        ? this.children.find((item) => item.className.split(' ').includes('selected')) || null
        : null;
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 100 };
    },
  };
}

function fixture() {
  const list = makeNode();
  const search = { value: '' };
  const elements = { 'tree-list': list, 'tree-search': search };
  const documentRef = {
    createElement: (tag) => makeNode(tag),
    createDocumentFragment: () => makeNode('fragment'),
  };
  const state = {
    trees: [
      { id: 92, index: 1, height: 5.08, species: 'incorrect-label' },
      { id: 93, index: 2, height: 4.1, species: 'incorrect-label' },
    ],
    current: { treeIndex: 1, frame: 'first.jpg' },
    displayedTreeIndex: 0,
  };
  return { list, search, state, documentRef, element: (id) => elements[id] };
}

test('列表仅显示编号和高度，不读取原始树种字段', async () => {
  const { createTreeListView } = await modulePromise;
  const f = fixture();
  createTreeListView(f).render();
  const [first, second] = f.list.children;
  assert.equal(first.children[0].children[0].textContent, '# 92');
  assert.equal(first.children[1].textContent, '5.1 m');
  assert.equal(first.attributes['aria-selected'], 'true');
  assert.equal(second.attributes['aria-selected'], 'false');
  assert.equal(JSON.stringify(f.list.children).includes('incorrect-label'), false);
});

test('同一树的帧和参数变化不重建列表；选树或替换数据时更新', async () => {
  const { createTreeListView } = await modulePromise;
  const f = fixture();
  const view = createTreeListView(f);
  view.render();
  const firstRow = f.list.children[0];
  f.state.current = { treeIndex: 1, frame: 'next.jpg', viewPan: 20 };
  for (let i = 0; i < 5; i += 1) view.render();
  assert.equal(f.list.replacements, 1);
  assert.equal(f.list.children[0], firstRow);
  f.state.current = { treeIndex: 2, frame: 'next.jpg' };
  view.render();
  assert.equal(f.list.replacements, 2);
  assert.equal(f.list.children[1].attributes['aria-selected'], 'true');
  f.state.trees = [{ id: 8, index: 1, height: 2 }];
  f.state.current = { treeIndex: 1 };
  view.render();
  assert.equal(f.list.replacements, 3);
  assert.equal(f.list.children[0].children[0].children[0].textContent, '# 8');
});

test('按树号搜索时更新结果并保留列表滚动位置', async () => {
  const { createTreeListView } = await modulePromise;
  const f = fixture();
  const view = createTreeListView(f);
  view.render();
  f.list.scrollTop = 42;
  f.search.value = '93';
  view.render();
  assert.equal(f.list.children.length, 1);
  assert.equal(f.list.children[0].dataset.index, '2');
  assert.equal(f.list.scrollTop, 42);
  f.search.value = 'incorrect-label';
  view.render();
  assert.equal(f.list.children[0].className, 'list-empty');
  assert.equal(f.list.children[0].textContent, '没有匹配的树木');
});
