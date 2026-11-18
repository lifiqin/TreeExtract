// 列表只依赖树集合、搜索词与当前树号；帧或投影变化不需要重建所有 DOM。
// 调用方更新树集合时应替换数组，而不是原地修改它。
export function createTreeListView({ element, state, documentRef = document }) {
  let rendered = null;

  function keepSelectedVisible() {
    const list = element('tree-list');
    const selected = list.querySelector('.tree-row.selected');
    if (!selected) return;
    const bounds = list.getBoundingClientRect();
    const row = selected.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
  }

  function render() {
    const list = element('tree-list');
    const query = element('tree-search').value.trim();
    const selectedIndex = state.current?.treeIndex;
    if (
      rendered &&
      rendered.trees === state.trees &&
      rendered.query === query &&
      rendered.selectedIndex === selectedIndex
    )
      return;

    const scroll = list.scrollTop;
    const matches = state.trees.filter((tree) => String(tree.id).includes(query));
    const fragment = documentRef.createDocumentFragment();
    for (const tree of matches) {
      const selected = tree.index === selectedIndex;
      const row = documentRef.createElement('button');
      row.type = 'button';
      row.className = `tree-row${selected ? ' selected' : ''}`;
      row.dataset.index = String(tree.index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      const name = documentRef.createElement('span');
      name.className = 'tree-id';
      const id = documentRef.createElement('strong');
      id.textContent = `# ${tree.id}`;
      name.append(id);
      const height = documentRef.createElement('small');
      height.textContent = `${Number(tree.height).toFixed(1)} m`;
      row.append(name, height);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    if (!matches.length) {
      const empty = documentRef.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = state.trees.length ? '没有匹配的树木' : '加载数据后显示树木';
      list.append(empty);
    }
    list.scrollTop = scroll;
    const selected = list.querySelector('.tree-row.selected');
    if (selected && state.displayedTreeIndex !== selectedIndex) {
      keepSelectedVisible();
      state.displayedTreeIndex = selectedIndex;
    }
    rendered = { trees: state.trees, query, selectedIndex };
  }

  return { render, keepSelectedVisible };
}
