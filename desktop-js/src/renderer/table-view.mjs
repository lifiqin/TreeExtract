// 对照表展示和选帧交互；数据的计算与导出仍由后端负责。
export function createTableView({ element, state, api, execute, documentRef = document }) {
  function render() {
    const query = element('table-search').value.trim().toLowerCase();
    const rows = state.table.filter((row) =>
      `${row.id} ${row.frame}`.toLowerCase().includes(query),
    );
    const body = element('table-body');
    const fragment = documentRef.createDocumentFragment();
    for (const row of rows) {
      const tr = documentRef.createElement('tr');
      tr.tabIndex = 0;
      const values = [
        row.id,
        Number(row.height).toFixed(2),
        row.frame,
        Number(row.distance).toFixed(2),
        Number(row.bearing).toFixed(2),
        Number(row.offset).toFixed(2),
      ];
      for (const value of values) {
        const td = documentRef.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      const select = async () => {
        element('table-dialog').close();
        await execute('正在定位对照表中的全景帧…', () => api.selectTableRow(row.id));
      };
      tr.addEventListener('dblclick', select);
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') select();
      });
      fragment.append(tr);
    }
    body.replaceChildren(fragment);
    element('table-count').textContent = `${rows.length} / ${state.table.length} 条`;
  }

  return { render };
}
