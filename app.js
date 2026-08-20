const state = {
  seed: null,
  sheets: [],
  activeIndex: 0,
  rows: [],
  isAdmin: false,
  user: null,
  supabase: null,
  remote: false,
  query: '',
  filter: 'all'
};

const $ = (id) => document.getElementById(id);
const sheetIcon = (index) => index === 0 ? '⌁' : '◈';
const activeSheet = () => state.sheets[state.activeIndex];
const text = (value) => value == null ? '' : String(value);
const rowText = (row) => (row.cells || []).map(text).join(' ').toLowerCase();
const escapeCsv = (value) => `"${text(value).replaceAll('"', '""')}"`;

async function boot() {
  bindEvents();
  await loadSeed();
  setupSupabase();
  renderAll();
  await restoreSession();
  if (state.remote) await loadRemote();
  renderAll();
}

async function loadSeed() {
  try {
    const response = await fetch('data/seed-data.json');
    if (!response.ok) throw new Error('demo seed not found');
    state.seed = await response.json();
  } catch (_error) {
    state.seed = getDemoSeed();
  }
  state.sheets = state.seed.sheets;
  state.rows = state.sheets[0].rows.map(cloneRow);
}

function getDemoSeed() {
  return {
    source: 'demo-preview',
    sheets: [
      { key: 'sheet-1', name: '关联件影响问题', columns: [
        { index: 0, label: '车辆' }, { index: 1, label: '状态' }, { index: 2, label: '阶段' }, { index: 3, label: '可用功能' }, { index: 4, label: '负责人' }
      ], rows: [
        { rowIndex: 1, cells: ['IS4PR-DEMO-001', '已反馈', 'EP车', 'All', '项目组'] },
        { rowIndex: 2, cells: ['IS4PR-DEMO-002', '待跟进', '集成', 'PAD / 车机', '联调负责人'] },
        { rowIndex: 3, cells: ['IS4PR-DEMO-003', '正常', '量产', '泊车', '验证负责人'] }
      ] },
      { key: 'sheet-2', name: '关联件管理', columns: [
        { index: 0, label: '序号' }, { index: 1, label: '条目' }, { index: 2, label: '功能状态' }, { index: 3, label: '车型 A' }, { index: 4, label: '备注' }
      ], rows: [
        { rowIndex: 1, cells: ['1', '临牌日期', '正常', '已配置', '演示数据'] },
        { rowIndex: 2, cells: ['2', '匿名 ID', '待确认', '待更新', '演示数据'] },
        { rowIndex: 3, cells: ['3', '车身参数', '已完成', '已同步', '演示数据'] }
      ] }
    ]
  };
}

function setupSupabase() {
  const config = window.APP_CONFIG || {};
  if (config.supabaseUrl && config.supabaseAnonKey && window.supabase) {
    state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    state.remote = true;
    $('connectionLabel').textContent = 'Supabase 在线';
    $('syncLabel').textContent = 'Supabase 数据';
  }
}

async function restoreSession() {
  if (!state.supabase) return;
  const { data } = await state.supabase.auth.getSession();
  if (data.session) await applySession(data.session);
  state.supabase.auth.onAuthStateChange(async (_event, session) => {
    if (session) await applySession(session); else clearSession();
    renderAll();
  });
}

async function applySession(session) {
  state.user = session.user;
  state.isAdmin = false;
  const { data: profile } = await state.supabase.from('profiles').select('role').eq('id', session.user.id).maybeSingle();
  state.isAdmin = profile?.role === 'admin';
  showToast(state.isAdmin ? '管理员已登录' : '已登录，当前为只读用户');
}

function clearSession() {
  state.user = null;
  state.isAdmin = false;
}

async function loadRemote() {
  try {
    const configs = await state.supabase.from('sheet_configs').select('key,name,columns,sort_order').order('sort_order');
    if (configs.error) throw configs.error;
    state.sheets = configs.data.map((item) => ({ key: item.key, name: item.name, columns: item.columns || [], rows: [] }));
    if (!state.sheets.length) throw new Error('没有找到工作表配置');
    await loadActiveRows();
  } catch (error) {
    console.warn(error);
    state.remote = false;
    $('connectionLabel').textContent = '演示数据模式';
    $('syncLabel').textContent = '本地预览';
    state.sheets = state.seed.sheets;
    state.rows = state.sheets[0].rows.map(cloneRow);
    showToast('线上数据未配置，已切换到演示模式');
  }
}

async function loadActiveRows() {
  const sheet = activeSheet();
  if (!state.remote || !state.supabase) {
    state.rows = sheet.rows.map(cloneRow);
    return;
  }
  const { data, error } = await state.supabase.from('sheet_rows').select('id,row_index,cells').eq('sheet_key', sheet.key).order('row_index');
  if (error) throw error;
  state.rows = (data || []).map((row) => ({ id: row.id, rowIndex: row.row_index, cells: Array.isArray(row.cells) ? row.cells : [] }));
}

function cloneRow(row) { return { ...row, cells: [...(row.cells || [])] }; }

function bindEvents() {
  $('searchInput').addEventListener('input', (event) => { state.query = event.target.value.trim().toLowerCase(); renderTable(); });
  $('clearSearchBtn').addEventListener('click', () => { state.query = ''; $('searchInput').value = ''; state.filter = 'all'; renderAll(); });
  $('refreshBtn').addEventListener('click', async () => { if (state.remote) await loadActiveRows(); renderAll(); showToast('数据已刷新'); });
  $('loginBtn').addEventListener('click', () => state.user ? signOut() : openModal('loginModal'));
  $('loginForm').addEventListener('submit', handleLogin);
  $('addRowBtn').addEventListener('click', addRow);
  $('exportBtn').addEventListener('click', exportCsv);
  $('adminHelpBtn').addEventListener('click', () => openModal('helpModal'));
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) backdrop.hidden = true; }));
}

function renderAll() {
  renderNav();
  renderMetrics();
  renderToolbar();
  renderFilters();
  renderTable();
  renderUser();
}

function renderNav() {
  $('sheetNav').innerHTML = state.sheets.map((sheet, index) => `
    <button class="nav-item ${index === state.activeIndex ? 'active' : ''}" data-sheet-index="${index}">
      <span class="nav-icon">${sheetIcon(index)}</span>
      <span class="nav-copy"><strong>${text(sheet.name)}</strong><small>${index === 0 ? '问题追踪 · 136 列' : '状态台账 · 21 列'}</small></span>
    </button>`).join('');
  document.querySelectorAll('[data-sheet-index]').forEach((button) => button.addEventListener('click', async () => {
    state.activeIndex = Number(button.dataset.sheetIndex);
    state.filter = 'all'; state.query = ''; $('searchInput').value = '';
    try { await loadActiveRows(); } catch (error) { showToast('加载失败，已保留当前数据'); }
    renderAll();
  }));
}

function renderToolbar() {
  const sheet = activeSheet();
  $('currentSheetCrumb').textContent = sheet.name;
  $('tableTitle').textContent = sheet.name;
  $('tableSubtitle').textContent = state.activeIndex === 0 ? '问题反馈、处理节点与车辆状态' : '关联件软件状态、车辆矩阵与配置记录';
  $('addRowBtn').hidden = !state.isAdmin;
}

function renderMetrics() {
  const filled = state.rows.reduce((total, row) => total + (row.cells || []).filter((cell) => text(cell).trim()).length, 0);
  const pending = state.rows.filter((row) => /待|问题|未|pending|todo/i.test(rowText(row))).length;
  const done = state.rows.filter((row) => /已完成|正常|ok|完成|closed|已解决/i.test(rowText(row))).length;
  const cards = [
    ['当前记录', state.rows.length, '▦', '#4363ff', '#eaf0ff'],
    ['有效单元格', filled.toLocaleString(), '✦', '#e646a1', '#fff0f8'],
    ['待跟进记录', pending, '!', '#ff974e', '#fff5e9'],
    ['已处理 / 正常', done, '✓', '#1dbf8b', '#e9fbf4']
  ];
  $('metrics').innerHTML = cards.map(([label, value, icon, accent, metric]) => `<div class="metric" style="--accent:${accent};--metric:${metric}"><div class="metric-top"><span class="metric-label">${label}</span><span class="metric-icon">${icon}</span></div><strong class="metric-value">${value}</strong></div>`).join('');
}

function renderFilters() {
  const filters = [
    ['all', '全部'], ['vehicle', '有车辆编号'], ['pending', '待跟进'], ['done', '已完成 / 正常']
  ];
  $('filterChips').innerHTML = filters.map(([key, label]) => `<button class="filter-chip ${state.filter === key ? 'active' : ''}" data-filter="${key}">${label}</button>`).join('');
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; renderFilters(); renderTable(); }));
}

function filteredRows() {
  return state.rows.filter((row) => {
    const haystack = rowText(row);
    const queryMatch = !state.query || haystack.includes(state.query);
    const filterMatch = state.filter === 'all' ||
      (state.filter === 'vehicle' && /is4pr-|vin|车辆/.test(haystack)) ||
      (state.filter === 'pending' && /待|问题|未|pending|todo/.test(haystack)) ||
      (state.filter === 'done' && /已完成|正常|ok|完成|closed|已解决/.test(haystack));
    return queryMatch && filterMatch;
  });
}

function renderTable() {
  const sheet = activeSheet();
  const columns = sheet.columns || [];
  const rows = filteredRows();
  $('resultCount').textContent = rows.length;
  $('tableHead').innerHTML = `<tr><th>#</th>${columns.map((column) => `<th title="${text(column.label)}">${text(column.label)}</th>`).join('')}${state.isAdmin ? '<th class="row-actions">操作</th>' : ''}</tr>`;
  $('tableBody').innerHTML = rows.map((row) => {
    const cells = columns.map((_, index) => `<td class="${state.isAdmin ? 'editable' : ''}" data-row-id="${text(row.id || row.rowIndex)}" data-cell-index="${index}">${formatCell(row.cells?.[index])}</td>`).join('');
    return `<tr><td>${row.rowIndex ?? ''}</td>${cells}${state.isAdmin ? `<td class="row-actions"><button class="delete-row" data-delete-row="${text(row.id || row.rowIndex)}">删除</button></td>` : ''}</tr>`;
  }).join('');
  $('emptyState').hidden = rows.length !== 0;
  if (state.isAdmin) {
    document.querySelectorAll('td.editable').forEach((cell) => cell.addEventListener('dblclick', beginEdit));
    document.querySelectorAll('[data-delete-row]').forEach((button) => button.addEventListener('click', () => deleteRow(button.dataset.deleteRow)));
  }
}

function formatCell(value) {
  const valueText = text(value);
  if (!valueText.trim()) return '<span style="color:#c7cdd9">—</span>';
  if (/^(已完成|正常|ok|已解决|完成)$/i.test(valueText.trim())) return `<span class="cell-status cell-good">${valueText}</span>`;
  if (/待|问题|未|pending|todo/i.test(valueText)) return `<span class="cell-status cell-warn">${valueText}</span>`;
  return valueText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
}

function beginEdit(event) {
  if (!state.isAdmin || event.currentTarget.querySelector('textarea')) return;
  const cell = event.currentTarget;
  const rowId = cell.dataset.rowId;
  const cellIndex = Number(cell.dataset.cellIndex);
  const row = state.rows.find((item) => String(item.id || item.rowIndex) === String(rowId));
  if (!row) return;
  const original = text(row.cells[cellIndex]);
  const input = document.createElement('textarea');
  input.className = 'cell-input'; input.value = original; input.rows = Math.min(5, Math.max(2, original.split('\n').length));
  cell.innerHTML = ''; cell.appendChild(input); input.focus(); input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    if (save && input.value !== original) await updateCell(row, cellIndex, input.value);
    else renderTable();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); commit(false); } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(true); } });
  input.addEventListener('blur', () => commit(true));
}

async function updateCell(row, cellIndex, value) {
  row.cells[cellIndex] = value;
  if (state.remote && state.supabase && row.id) {
    const { error } = await state.supabase.from('sheet_rows').update({ cells: row.cells }).eq('id', row.id);
    if (error) { showToast('保存失败：请检查管理员权限'); return; }
  } else {
    persistDemo();
  }
  renderAll(); showToast('单元格已保存');
}

async function addRow() {
  const sheet = activeSheet();
  const newRow = { rowIndex: state.rows.length ? Math.max(...state.rows.map((row) => Number(row.rowIndex) || 0)) + 1 : 1, cells: sheet.columns.map(() => '') };
  if (state.remote && state.supabase) {
    const { data, error } = await state.supabase.from('sheet_rows').insert({ sheet_key: sheet.key, row_index: newRow.rowIndex, cells: newRow.cells }).select('id,row_index,cells').single();
    if (error) { showToast('新增失败：请检查管理员权限'); return; }
    newRow.id = data.id;
  }
  state.rows.push(newRow); persistDemo(); renderAll(); showToast('已新增一行');
}

async function deleteRow(rowKey) {
  if (!confirm('确定删除这一整行吗？此操作不可撤销。')) return;
  const row = state.rows.find((item) => String(item.id || item.rowIndex) === String(rowKey));
  if (state.remote && state.supabase && row?.id) {
    const { error } = await state.supabase.from('sheet_rows').delete().eq('id', row.id);
    if (error) { showToast('删除失败：请检查管理员权限'); return; }
  }
  state.rows = state.rows.filter((item) => String(item.id || item.rowIndex) !== String(rowKey));
  persistDemo(); renderAll(); showToast('记录已删除');
}

function persistDemo() {
  if (state.remote) return;
  const key = `linked-parts-${activeSheet().key}`;
  localStorage.setItem(key, JSON.stringify(state.rows));
}

async function handleLogin(event) {
  event.preventDefault();
  const email = $('emailInput').value.trim(); const password = $('passwordInput').value;
  $('loginMessage').textContent = '正在验证…';
  if (!state.supabase && email === 'admin@demo.local' && password === 'admin123') {
    state.isAdmin = true; state.user = { email }; closeModal('loginModal'); renderAll(); showToast('演示管理员已登录'); return;
  }
  if (!state.supabase) { $('loginMessage').textContent = '演示模式账号不正确，请使用提示中的账号。'; return; }
  const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
  if (error) { $('loginMessage').textContent = error.message; return; }
  await applySession(data.session); closeModal('loginModal'); renderAll();
}

async function signOut() {
  if (state.supabase) await state.supabase.auth.signOut();
  clearSession(); renderAll(); showToast('已退出登录');
}

function exportCsv() {
  const sheet = activeSheet(); const rows = filteredRows();
  const lines = [['#', ...(sheet.columns || []).map((column) => column.label)].map(escapeCsv).join(',')];
  rows.forEach((row) => lines.push([row.rowIndex, ...(row.cells || [])].map(escapeCsv).join(',')));
  const blob = new Blob(["\ufeff" + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${sheet.name}.csv`; anchor.click(); URL.revokeObjectURL(url); showToast('当前视图已导出');
}

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
function renderUser() {
  $('userLabel').textContent = state.user ? (state.isAdmin ? '管理员' : '只读用户') : '访客查看';
  $('loginBtn').title = state.user ? '点击退出登录' : '管理员登录';
  $('loginBtn').querySelector('.avatar').textContent = state.user ? (state.isAdmin ? '管' : '用') : '访';
  document.querySelectorAll('.admin-only').forEach((element) => { element.hidden = !state.isAdmin; });
}
let toastTimer;
function showToast(message) { const toast = $('toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2400); }

boot().catch((error) => { console.error(error); showToast('数据加载失败，请检查 data/seed-data.json'); });

