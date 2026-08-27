const state = {
  supabase: null,
  remote: false,
  showDemo: false,
  user: null,
  isAdmin: false,
  vehicles: [],
  records: [],
  selectedVehicleId: null,
  query: '',
  authMode: 'login',
  syncing: false
};

const $ = (id) => document.getElementById(id);
const text = (value) => value == null ? '' : String(value);
const clean = (value) => text(value).trim();
const escapeHtml = (value) => text(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');
const multiline = (value, empty = '—') => {
  const content = clean(value);
  return content ? escapeHtml(content).replaceAll('\n', '<br>') : `<span class="muted-value">${empty}</span>`;
};
const escapeCsv = (value) => `"${text(value).replaceAll('"', '""')}"`;
const canManage = () => state.remote && !state.showDemo && state.isAdmin;

async function boot() {
  bindEvents();
  await loadDemo();
  setupSupabase();
  await restoreSession();

  if (state.remote) await loadRemote();

  renderAll();
}

function setupSupabase() {
  const config = window.APP_CONFIG || {};
  if (new URLSearchParams(window.location.search).get('demo') === '1') return;
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase) return;
  state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  state.remote = true;
  state.showDemo = false;
}

async function restoreSession() {
  if (!state.supabase) return;
  try {
    const { data, error } = await state.supabase.auth.getSession();
    if (error) throw error;
    if (data.session) await applySession(data.session);
  } catch (error) {
    console.warn('Unable to restore Supabase session.', error);
  }

  state.supabase.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(async () => {
      if (session) {
        await applySession(session);
      } else {
        clearSession();
      }
      await loadRemote();
      renderAll();
    }, 0);
  });
}

async function applySession(session) {
  state.user = session.user;
  state.isAdmin = false;
  const { data, error } = await state.supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .maybeSingle();
  if (!error) state.isAdmin = data?.role === 'admin';
}

function clearSession() {
  state.user = null;
  state.isAdmin = false;
}

async function loadDemo() {
  try {
    const response = await fetch('data/vehicle-components.demo.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Demo data is unavailable.');
    useDataset(await response.json(), true);
  } catch (error) {
    console.warn('Unable to load demo data.', error);
    useDataset(getFallbackDemo(), true);
  }
}

function getFallbackDemo() {
  return {
    vehicles: [
      { id: 'demo-001', vehicleCode: 'IS4PR-DEMO-001', vin: 'DEMO0000000000001' },
      { id: 'demo-002', vehicleCode: 'IS4PR-DEMO-002', vin: 'DEMO0000000000002' }
    ],
    records: [
      { id: 'demo-001-ccu', vehicleId: 'demo-001', componentName: 'CCU', versionLabel: 'F194 / 软件版本', versionValue: 'DEMO-SW-1.0.0' },
      { id: 'demo-001-ipd', vehicleId: 'demo-001', componentName: 'IPD', versionLabel: '配置字', versionValue: 'DEMO-CONFIG-A' },
      { id: 'demo-002-ccu', vehicleId: 'demo-002', componentName: 'CCU', versionLabel: 'F194 / 软件版本', versionValue: 'DEMO-SW-1.1.0' }
    ]
  };
}

function useDataset(dataset, showDemo) {
  state.showDemo = showDemo;
  state.vehicles = (dataset.vehicles || []).map((vehicle, index) => ({
    id: text(vehicle.id || vehicle.vehicleId || `local-vehicle-${index + 1}`),
    vehicleCode: clean(vehicle.vehicleCode ?? vehicle.vehicle_code),
    vin: clean(vehicle.vin),
    sourceHeader: clean(vehicle.sourceHeader ?? vehicle.source_header),
    createdAt: vehicle.createdAt ?? vehicle.created_at,
    updatedAt: vehicle.updatedAt ?? vehicle.updated_at
  })).filter((vehicle) => vehicle.vehicleCode);

  state.records = (dataset.records || []).map((record, index) => ({
    id: text(record.id || `local-record-${index + 1}`),
    vehicleId: text(record.vehicleId ?? record.vehicle_id),
    componentName: clean(record.componentName ?? record.component_name),
    componentCategory: clean(record.componentCategory ?? record.component_category),
    versionLabel: clean(record.versionLabel ?? record.version_label),
    versionValue: clean(record.versionValue ?? record.version_value),
    note: clean(record.note),
    sourceRow: record.sourceRow ?? record.source_row,
    sourceColumn: record.sourceColumn ?? record.source_column
  })).filter((record) => record.vehicleId && record.componentName && record.versionLabel);

  if (!state.vehicles.some((vehicle) => vehicle.id === state.selectedVehicleId)) {
    state.selectedVehicleId = state.vehicles[0]?.id || null;
  }
}

async function loadRemote() {
  if (!state.supabase) return;
  try {
    const [vehicles, records] = await Promise.all([
      fetchAll('vehicles', 'id,vehicle_code,vin,source_header,created_at,updated_at', ['vehicle_code']),
      fetchAll('vehicle_component_versions', 'id,vehicle_id,component_name,component_category,version_label,version_value,note,source_row,source_column', ['vehicle_id', 'component_name', 'version_label'])
    ]);
    useDataset({ vehicles, records }, false);
  } catch (error) {
    console.warn('Unable to load vehicle records.', error);
    await loadDemo();
    showToast('线上公开读取尚未启用，已切换为脱敏演示数据');
  }
}

async function fetchAll(table, fields, orderColumns) {
  const pageSize = 1000;
  const result = [];
  let offset = 0;

  while (true) {
    let request = state.supabase.from(table).select(fields);
    orderColumns.forEach((column) => {
      request = request.order(column, { ascending: true });
    });
    const { data, error } = await request.range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = data || [];
    result.push(...page);
    if (page.length < pageSize) return result;
    offset += pageSize;
  }
}

function bindEvents() {
  $('searchInput').addEventListener('input', (event) => {
    state.query = clean(event.target.value).toLowerCase();
    renderVehicleCards();
  });
  $('clearSearchBtn').addEventListener('click', () => {
    state.query = '';
    $('searchInput').value = '';
    renderVehicleCards();
  });
  $('refreshBtn').addEventListener('click', refreshData);
  $('authBtn').addEventListener('click', () => {
    if (state.user) signOut();
    else openAuthModal('login');
  });
  $('addVehicleBtn').addEventListener('click', () => openVehicleModal());
  $('authForm').addEventListener('submit', handleAuth);
  $('authModeToggle').addEventListener('click', () => openAuthModal(state.authMode === 'login' ? 'register' : 'login'));
  $('vehicleForm').addEventListener('submit', saveVehicle);
  $('versionForm').addEventListener('submit', saveVersion);
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeModal(backdrop.id);
    });
  });
  document.addEventListener('click', handleAction);
}

async function handleAction(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const { action } = trigger.dataset;

  if (action === 'open-auth') openAuthModal('login');
  if (action === 'select-vehicle') {
    state.selectedVehicleId = trigger.dataset.vehicleId;
    renderVehicleCards();
    renderDetail();
    openModal('detailModal');
  }
  if (action === 'reopen-detail') openModal('detailModal');
  if (action === 'edit-vehicle') openVehicleModal(getSelectedVehicle());
  if (action === 'delete-vehicle') await deleteVehicle(getSelectedVehicle());
  if (action === 'add-version') openVersionModal();
  if (action === 'edit-version') openVersionModal(findRecord(trigger.dataset.versionId));
  if (action === 'delete-version') await deleteVersion(findRecord(trigger.dataset.versionId));
  if (action === 'export-vehicle') exportVehicleCsv();
}

function getSyncFunctionUrl() {
  const config = window.APP_CONFIG || {};
  if (config.syncFunctionUrl) return config.syncFunctionUrl;
  return config.supabaseUrl ? config.supabaseUrl + '/functions/v1/feishu-sync-now' : '';
}

async function triggerImmediateSync() {
  const syncUrl = getSyncFunctionUrl();
  if (!syncUrl) throw new Error('未配置立即同步入口。');

  const config = window.APP_CONFIG || {};
  const response = await fetch(syncUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.supabaseAnonKey || ''
    },
    body: JSON.stringify({ source: 'manual-button' })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new Error(clean(payload?.error || payload?.message) || ('立即同步失败 (' + response.status + ')'));
  }
  return payload || {};
}

async function refreshData() {
  if (state.syncing) return;

  if (state.remote && !state.showDemo) {
    state.syncing = true;
    renderAll();
    showToast('已开始同步，正在从飞书拉取最新数据…');

    try {
      const payload = await triggerImmediateSync();
      await loadRemote();
      renderAll();
      const vehicleCount = payload.vehicleCount ?? state.vehicles.length;
      const recordCount = payload.recordCount ?? state.records.length;
      showToast('同步完成：' + vehicleCount + ' 台车，' + recordCount + ' 条版本记录');
      return;
    } catch (error) {
      showToast(readableError(error));
    } finally {
      state.syncing = false;
      renderAll();
    }
    return;
  }

  if (!state.remote) {
    await loadDemo();
    renderAll();
    showToast('演示数据已刷新');
  }
}

function renderAll() {
  renderConnection();
  renderUser();
  renderSyncButton();
  renderMetrics();
  renderVehicleCards();
  renderDetail();
  $('addVehicleBtn').hidden = !canManage();
}

function renderConnection() {
  const label = state.syncing
    ? '飞书同步中 · 请稍候'
    : state.showDemo
      ? '脱敏演示数据'
      : state.remote && state.user && state.isAdmin
        ? 'Supabase 在线 · 管理员'
        : state.remote && state.user
          ? 'Supabase 在线 · 只读'
          : state.remote
            ? 'Supabase 在线 · 游客可看'
            : '本地演示模式';
  $('connectionLabel').textContent = label;
}

function renderUser() {
  const label = state.isAdmin ? '管理员 · 退出' : state.user ? '只读用户 · 退出' : '游客查看';
  $('userLabel').textContent = label;
  $('avatarLabel').textContent = state.isAdmin ? '管' : state.user ? '只' : '访';
  $('authBtn').title = state.user ? '退出登录' : '登录只读账号或管理员账号';
}

function renderSyncButton() {
  const button = $('refreshBtn');
  const label = $('refreshLabel');
  if (!button || !label) return;

  const loading = state.syncing;
  button.disabled = loading;
  button.classList.toggle('is-loading', loading);
  button.setAttribute('aria-busy', loading ? 'true' : 'false');
  button.title = loading ? '正在从飞书同步数据' : '立即从飞书同步最新数据';
  label.textContent = loading ? '同步中…' : '立即同步';
}

function renderMetrics() {
  const vehicleCount = state.vehicles.length;
  const componentCount = new Set(state.records.map((record) => record.componentName)).size;
  const versionCount = state.records.length;
  const vinCount = state.vehicles.filter((vehicle) => vehicle.vin).length;
  const metrics = [
    ['车辆', vehicleCount, '▦', 'violet'],
    ['关联件', componentCount, '◈', 'blue'],
    ['版本记录', versionCount, '⌁', 'teal'],
    ['已登记 VIN', vinCount, '✓', 'orange']
  ];
  $('metrics').innerHTML = metrics.map(([label, value, icon, tone]) => `
    <article class="metric metric-${tone}">
      <span class="metric-icon">${icon}</span>
      <span class="metric-label">${label}</span>
      <strong>${value.toLocaleString()}</strong>
    </article>`).join('');
}

function filteredVehicles() {
  if (!state.query) return state.vehicles;
  return state.vehicles.filter((vehicle) => vehicleSearchText(vehicle).includes(state.query));
}

function vehicleSearchText(vehicle) {
  const records = getRecords(vehicle.id);
  return [
    vehicle.vehicleCode,
    vehicle.vin,
    vehicle.sourceHeader,
    ...records.flatMap((record) => [record.componentName, record.componentCategory, record.versionLabel, record.versionValue, record.note])
  ].join(' ').toLowerCase();
}

function renderVehicleCards() {
  const empty = $('vehicleEmpty');
  const vehicles = filteredVehicles();
  if (!vehicles.length) {
    $('vehicleGrid').innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = `<span class="empty-icon">◌</span><h3>${state.vehicles.length ? '没有匹配的车辆' : '暂无关联件数据'}</h3><p>${state.vehicles.length ? '请尝试更换关键词。' : '游客可直接查看；管理员登录后可新增、修改、删除。'}</p>`;
    return;
  }

  empty.hidden = true;
  $('vehicleGrid').innerHTML = vehicles.map((vehicle) => {
    const records = getRecords(vehicle.id);
    const componentCount = new Set(records.map((record) => record.componentName)).size;
    const selected = vehicle.id === state.selectedVehicleId;
    return `<button class="vehicle-card ${selected ? 'selected' : ''}" type="button" data-action="select-vehicle" data-vehicle-id="${escapeHtml(vehicle.id)}" aria-pressed="${selected}">
      <span class="card-top"><span class="vehicle-state"><i></i>已归档</span><span class="card-arrow">→</span></span>
      <strong>${escapeHtml(vehicle.vehicleCode)}</strong>
      <span class="vehicle-vin">${vehicle.vin ? `VIN · ${escapeHtml(vehicle.vin)}` : 'VIN 待补充'}</span>
      <span class="card-divider"></span>
      <span class="card-stats"><b>${componentCount}</b> 个关联件 <em>·</em> <b>${records.length}</b> 条版本</span>
    </button>`;
  }).join('');
}

function renderDetail() {
  const panel = $('detailPanel');
  const vehicle = getSelectedVehicle();
  if (!vehicle) {
    panel.innerHTML = `<div class="detail-placeholder"><span class="placeholder-icon">⌁</span><h2>选择一辆车</h2><p>点击车辆卡片后，会以覆盖弹层的方式展开这台车的完整关联件版本信息。</p></div>`;
    $('detailModalContent').innerHTML = '';
    closeModal('detailModal');
    return;
  }

  const records = getRecords(vehicle.id);
  const groups = groupRecords(records);
  panel.innerHTML = `<div class="detail-placeholder detail-preview"><span class="placeholder-icon">▣</span><h2>${escapeHtml(vehicle.vehicleCode)}</h2><p>已选中这台车。完整关联件版本会以覆盖层方式单独展开。</p><button class="secondary-button preview-open-button" type="button" data-action="reopen-detail">打开覆盖详情</button></div>`;
  $('detailModalContent').innerHTML = renderDetailOverlay(vehicle, records, groups);
}

function renderDetailOverlay(vehicle, records, groups) {
  return `<div class="detail-modal-shell">
    <div class="detail-header">
      <div>
        <p class="section-kicker">VEHICLE DETAIL</p>
        <h2 id="detailModalTitle">${escapeHtml(vehicle.vehicleCode)}</h2>
        <p class="detail-vin">${vehicle.vin ? `VIN · ${escapeHtml(vehicle.vin)}` : 'VIN 待补充'}</p>
      </div>
      <div class="detail-actions">
        <button class="icon-button compact" type="button" data-action="export-vehicle" title="导出当前车辆版本清单" aria-label="导出当前车辆版本清单">⇩</button>
        ${canManage() ? `<button class="icon-button compact" type="button" data-action="edit-vehicle" title="编辑车辆" aria-label="编辑车辆">✎</button><button class="icon-button compact danger" type="button" data-action="delete-vehicle" title="删除车辆" aria-label="删除车辆">×</button>` : ''}
      </div>
    </div>
    <div class="detail-summary"><span>${groups.length} 个关联件</span><span>${records.length} 条版本记录</span>${state.showDemo ? '<span>脱敏演示</span>' : ''}</div>
    <div class="component-list detail-overlay-list">
      ${groups.length ? renderVehicleRecordBoard(groups) : `<div class="component-empty"><p>该车辆暂未添加关联件版本。</p></div>`}
    </div>
    ${canManage() ? `<button class="secondary-button add-version" type="button" data-action="add-version">＋ 新增关联件版本</button>` : ''}
  </div>`;
}

function renderVehicleRecordBoard(groups) {
  return `<section class="vehicle-record-board">${groups.map(renderBoardGroup).join('')}</section>`;
}

function renderBoardGroup(group) {
  const note = group.records.map((record) => record.note).find(Boolean);
  return `<section class="board-group">
    <div class="board-heading"><div><h3>${escapeHtml(group.name)}</h3></div><span>${group.records.length} 条</span></div>
    ${note ? `<p class="component-note">${multiline(note)}</p>` : ''}
    <div class="version-table board-table">
      ${group.records.map((record) => `<div class="version-row">
        <span class="version-label">${escapeHtml(record.versionLabel)}</span>
        <span class="version-value">${multiline(record.versionValue)}</span>
        ${canManage() ? `<span class="version-actions"><button type="button" data-action="edit-version" data-version-id="${escapeHtml(record.id)}" title="编辑">✎</button><button type="button" data-action="delete-version" data-version-id="${escapeHtml(record.id)}" title="删除">×</button></span>` : ''}
      </div>`).join('')}
    </div>
  </section>`;
}

function getRecords(vehicleId) {
  return state.records
    .filter((record) => record.vehicleId === vehicleId)
    .sort((left, right) => left.componentName.localeCompare(right.componentName, 'zh-CN') || left.versionLabel.localeCompare(right.versionLabel, 'zh-CN'));
}

function groupRecords(records) {
  const groups = new Map();
  records.forEach((record) => {
    if (!groups.has(record.componentName)) groups.set(record.componentName, { name: record.componentName, records: [] });
    groups.get(record.componentName).records.push(record);
  });
  return [...groups.values()];
}

function getSelectedVehicle() {
  return state.vehicles.find((vehicle) => vehicle.id === state.selectedVehicleId) || null;
}

function findRecord(id) {
  return state.records.find((record) => record.id === id) || null;
}

function openAuthModal(mode) {
  if (!state.supabase) {
    showToast('未配置 Supabase，当前仅可查看脱敏演示数据');
    return;
  }
  state.authMode = mode;
  const register = mode === 'register';
  $('authKicker').textContent = register ? 'VIEWER REGISTRATION' : 'ACCOUNT ACCESS';
  $('authModalTitle').textContent = register ? '注册只读账号' : '账号登录';
  $('authDescription').textContent = register
    ? '注册后默认是只读访客。需要编辑权限时，请由管理员在 Supabase 中授予管理员角色。'
    : '游客无需登录即可查看；登录后默认仍为只读，仅管理员账号可维护车辆与关联件版本。';
  $('authSubmitBtn').textContent = register ? '注册只读账号' : '登录';
  $('authModeToggle').textContent = register ? '已有账号？返回登录' : '没有账号？注册只读账号';
  $('passwordInput').autocomplete = register ? 'new-password' : 'current-password';
  $('authMessage').textContent = '';
  $('authForm').reset();
  openModal('authModal');
  $('emailInput').focus();
}

async function handleAuth(event) {
  event.preventDefault();
  if (!state.supabase) return;
  const email = clean($('emailInput').value);
  const password = $('passwordInput').value;
  const message = $('authMessage');
  const submit = $('authSubmitBtn');
  message.textContent = '';
  submit.disabled = true;

  try {
    if (state.authMode === 'register') {
      const { data, error } = await state.supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` }
      });
      if (error) throw error;
      if (!data.session) message.textContent = '注册成功，请前往邮箱完成验证后再登录。';
      else {
        closeModal('authModal');
        showToast('只读账号已注册并登录');
      }
    } else {
      const { error } = await state.supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      closeModal('authModal');
      showToast('登录成功，正在刷新权限');
    }
  } catch (error) {
    message.textContent = readableError(error);
  } finally {
    submit.disabled = false;
  }
}

async function signOut() {
  if (!state.supabase) return;
  const { error } = await state.supabase.auth.signOut();
  if (error) {
    showToast(readableError(error));
    return;
  }
  clearSession();
  await loadRemote();
  renderAll();
  showToast('已退出登录，当前为游客只读模式');
}

function openVehicleModal(vehicle = null) {
  if (!canManage()) return;
  $('vehicleForm').reset();
  $('vehicleMessage').textContent = '';
  $('vehicleIdInput').value = vehicle?.id || '';
  $('vehicleCodeInput').value = vehicle?.vehicleCode || '';
  $('vinInput').value = vehicle?.vin || '';
  $('sourceHeaderInput').value = vehicle?.sourceHeader || '';
  $('vehicleModalTitle').textContent = vehicle ? '编辑车辆' : '新增车辆';
  openModal('vehicleModal');
  $('vehicleCodeInput').focus();
}

async function saveVehicle(event) {
  event.preventDefault();
  if (!canManage()) return;
  const id = clean($('vehicleIdInput').value);
  const payload = {
    vehicle_code: clean($('vehicleCodeInput').value),
    vin: clean($('vinInput').value) || null,
    source_header: clean($('sourceHeaderInput').value) || null
  };
  const message = $('vehicleMessage');
  message.textContent = '';

  try {
    let response;
    if (id) response = await state.supabase.from('vehicles').update(payload).eq('id', id).select('id').single();
    else response = await state.supabase.from('vehicles').insert(payload).select('id').single();
    if (response.error) throw response.error;
    state.selectedVehicleId = response.data.id;
    await loadRemote();
    closeModal('vehicleModal');
    renderAll();
    showToast(id ? '车辆已更新' : '车辆已新增');
  } catch (error) {
    message.textContent = readableError(error);
  }
}

function openVersionModal(record = null) {
  if (!canManage()) return;
  const vehicle = getSelectedVehicle();
  if (!vehicle) return;
  $('versionForm').reset();
  $('versionMessage').textContent = '';
  $('versionIdInput').value = record?.id || '';
  $('componentNameInput').value = record?.componentName || '';
  $('componentCategoryInput').value = record?.componentCategory || '';
  $('versionLabelInput').value = record?.versionLabel || '';
  $('versionValueInput').value = record?.versionValue || '';
  $('versionNoteInput').value = record?.note || '';
  $('versionModalTitle').textContent = record ? '编辑关联件版本' : '新增关联件版本';
  $('versionVehicleName').textContent = `车辆：${vehicle.vehicleCode}`;
  openModal('versionModal');
  $('componentNameInput').focus();
}

async function saveVersion(event) {
  event.preventDefault();
  if (!canManage()) return;
  const vehicle = getSelectedVehicle();
  if (!vehicle) return;
  const id = clean($('versionIdInput').value);
  const payload = {
    vehicle_id: vehicle.id,
    component_name: clean($('componentNameInput').value),
    component_category: clean($('componentCategoryInput').value) || null,
    version_label: clean($('versionLabelInput').value),
    version_value: clean($('versionValueInput').value) || null,
    note: clean($('versionNoteInput').value) || null
  };
  const message = $('versionMessage');
  message.textContent = '';

  try {
    let response;
    if (id) response = await state.supabase.from('vehicle_component_versions').update(payload).eq('id', id).select('id').single();
    else response = await state.supabase.from('vehicle_component_versions').insert(payload).select('id').single();
    if (response.error) throw response.error;
    await loadRemote();
    closeModal('versionModal');
    renderAll();
    showToast(id ? '版本记录已更新' : '版本记录已新增');
  } catch (error) {
    message.textContent = readableError(error);
  }
}

async function deleteVehicle(vehicle) {
  if (!canManage() || !vehicle) return;
  if (!window.confirm(`确定删除车辆 ${vehicle.vehicleCode} 及其全部关联件版本吗？此操作无法撤销。`)) return;
  const { error } = await state.supabase.from('vehicles').delete().eq('id', vehicle.id);
  if (error) {
    showToast(readableError(error));
    return;
  }
  state.selectedVehicleId = null;
  await loadRemote();
  renderAll();
  showToast('车辆及关联件版本已删除');
}

async function deleteVersion(record) {
  if (!canManage() || !record) return;
  if (!window.confirm(`确定删除「${record.componentName} · ${record.versionLabel}」吗？`)) return;
  const { error } = await state.supabase.from('vehicle_component_versions').delete().eq('id', record.id);
  if (error) {
    showToast(readableError(error));
    return;
  }
  await loadRemote();
  renderAll();
  showToast('版本记录已删除');
}

function exportVehicleCsv() {
  const vehicle = getSelectedVehicle();
  if (!vehicle) return;
  const rows = [
    ['车辆编号', 'VIN', '关联件', '分类', '版本字段', '版本值', '备注'],
    ...getRecords(vehicle.id).map((record) => [vehicle.vehicleCode, vehicle.vin, record.componentName, record.componentCategory, record.versionLabel, record.versionValue, record.note])
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${vehicle.vehicleCode.replace(/[^\w-]+/g, '_')}-关联件版本.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function openModal(id) {
  $(id).hidden = false;
}

function closeModal(id) {
  $(id).hidden = true;
}

function readableError(error) {
  const message = clean(error?.message || error);
  if (/duplicate key|unique constraint/i.test(message)) return '该记录已存在，请检查车辆编号或版本字段。';
  if (/row-level security|permission denied/i.test(message)) return '没有管理员权限，无法保存修改。';
  if (/invalid login credentials/i.test(message)) return '邮箱或密码不正确。';
  if (/email not confirmed/i.test(message)) return '请先完成邮箱验证。';
  return message || '操作失败，请稍后重试。';
}

let toastTimer;
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3200);
}

boot();
