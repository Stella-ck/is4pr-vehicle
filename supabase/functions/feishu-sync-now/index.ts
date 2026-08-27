// @ts-nocheck
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const sheetToken = mustGetEnv('FEISHU_SHEET_TOKEN');
const sheetName = Deno.env.get('FEISHU_SHEET_NAME') || '关联件管理';
const supabaseUrl = mustGetEnv('SUPABASE_URL');
const supabaseServiceRoleKey = mustGetEnv('SUPABASE_SERVICE_ROLE_KEY');

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405);
  }

  try {
    const accessToken = await getTenantAccessToken();
    const targetSheet = await getTargetSheet(accessToken);
    const rows = await fetchSheetRows(accessToken, targetSheet);
    const dataset = parseSheetRows(rows);
    const summary = await syncDataset(dataset);

    return jsonResponse({
      ok: true,
      sheetId: targetSheet.sheetId,
      sheetTitle: targetSheet.title,
      syncedAt: new Date().toISOString(),
      vehicleCount: summary.vehicleCount,
      recordCount: summary.recordCount
    });
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, error: readableError(error) }, 500);
  }
});

function mustGetEnv(name) {
  const value = clean(Deno.env.get(name));
  if (!value) throw new Error('Missing required environment variable: ' + name);
  return value;
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function nullable(value) {
  const content = clean(value);
  return content || null;
}

function readableError(error) {
  const message = clean(error && error.message ? error.message : error);
  return message || '同步失败，请稍后重试。';
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error('Feishu API request failed (' + response.status + '): ' + raw);
  }
  if (payload && typeof payload.code !== 'undefined' && payload.code !== 0) {
    throw new Error('Feishu API error ' + payload.code + ': ' + (payload.msg || raw));
  }

  return payload;
}

async function getTenantAccessToken() {
  const payload = await requestJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: mustGetEnv('FEISHU_APP_ID'),
      app_secret: mustGetEnv('FEISHU_APP_SECRET')
    })
  });

  const token = clean(payload && payload.tenant_access_token);
  if (!token) throw new Error('Feishu tenant_access_token is empty.');
  return token;
}

async function getTargetSheet(accessToken) {
  const payload = await requestJson('https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/' + sheetToken + '/sheets/query', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });

  const targetName = clean(sheetName);
  const sheets = Array.isArray(payload?.data?.sheets) ? payload.data.sheets : [];
  const target = sheets.find((sheet) => clean(sheet?.title) === targetName)
    || sheets.find((sheet) => clean(sheet?.title).includes(targetName));

  if (!target?.sheet_id) {
    throw new Error('Worksheet not found: ' + targetName);
  }

  const rowCount = Number(target?.grid_properties?.row_count || 0);
  const columnCount = Number(target?.grid_properties?.column_count || 0);
  if (!rowCount || !columnCount) {
    throw new Error('Target worksheet has invalid grid properties.');
  }

  return {
    sheetId: target.sheet_id,
    title: clean(target.title),
    rowCount,
    columnCount
  };
}

async function fetchSheetRows(accessToken, targetSheet) {
  const lastColumn = columnIndexToLetters(targetSheet.columnCount - 1);
  const range = targetSheet.sheetId + '!A1:' + lastColumn + targetSheet.rowCount;
  const payload = await requestJson('https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/' + sheetToken + '/values/' + encodeURIComponent(range), {
    headers: { Authorization: 'Bearer ' + accessToken }
  });

  const rows = Array.isArray(payload?.data?.valueRange?.values) ? payload.data.valueRange.values : [];
  return rows.map((row) => Array.isArray(row) ? row.map(cellToText) : []);
}

function cellToText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(cellToText).join('');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return clean(value.text);
    if (typeof value.name === 'string') return clean(value.name);
    if (typeof value.content === 'string') return clean(value.content);
    return '';
  }
  return clean(value);
}

function parseSheetRows(rows) {
  const headerRowIndex = 1;
  const headerRow = rows[headerRowIndex] || [];
  const vehicleColumns = [];
  const vehicles = [];

  for (let columnIndex = 0; columnIndex < headerRow.length; columnIndex += 1) {
    const headerValue = clean(headerRow[columnIndex]);
    const vehicleMatch = headerValue.match(/\bIS4PR[-–—]?[A-Z0-9]+\b/i);
    if (!vehicleMatch) continue;
    const vehicleCode = vehicleMatch[0].toUpperCase().replace(/[–—]/g, '-');
    const vinMatch = headerValue.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
    const vehicle = {
      vehicleCode,
      vin: vinMatch ? vinMatch[0] : null,
      sourceHeader: headerValue
    };
    vehicles.push(vehicle);
    vehicleColumns.push({
      columnIndex,
      sourceColumn: columnIndexToLetters(columnIndex),
      vehicle
    });
  }

  if (!vehicleColumns.length) {
    throw new Error('No IS4PR vehicle headers found in row 2.');
  }

  const records = [];
  const seen = new Set();
  let currentCategory = '';
  let currentComponent = '';
  let currentNote = '';

  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const categoryCell = getCellText(row, 2);
    const descriptor = getCellText(row, 3);
    const rowNote = getCellText(row, 4);
    const versionField = getCellText(row, 5);
    if (categoryCell) currentCategory = categoryCell;
    if (!descriptor && !versionField) continue;

    let componentName = '';
    let componentCategory = currentCategory;
    let versionLabel = '';
    let effectiveNote = rowNote;

    if (descriptor) {
      const isControllerName = Boolean(versionField && /^[A-Za-z0-9_-]{2,20}$/.test(descriptor));
      if (isControllerName) {
        componentName = descriptor;
        versionLabel = versionField;
      } else if (versionField) {
        componentName = currentCategory ? currentCategory + ' / ' + descriptor : descriptor;
        versionLabel = versionField;
      } else {
        componentName = currentCategory || descriptor;
        versionLabel = descriptor;
      }
      currentComponent = componentName;
      currentNote = rowNote;
    } else if (currentComponent && versionField) {
      componentName = currentComponent;
      versionLabel = versionField;
      if (!effectiveNote) effectiveNote = currentNote;
    }

    if (!componentName || !versionLabel) continue;

    for (const vehicleColumn of vehicleColumns) {
      const versionValue = getCellText(row, vehicleColumn.columnIndex);
      if (!versionValue) continue;
      const recordKey = [vehicleColumn.vehicle.vehicleCode, componentName, versionLabel].join('__KEY__');
      if (seen.has(recordKey)) continue;
      seen.add(recordKey);
      records.push({
        vehicleCode: vehicleColumn.vehicle.vehicleCode,
        componentName,
        componentCategory: componentCategory || null,
        versionLabel,
        versionValue,
        note: effectiveNote || null,
        sourceRow: rowIndex + 1,
        sourceColumn: vehicleColumn.sourceColumn
      });
    }
  }

  return { vehicles, records };
}

function getCellText(row, index) {
  return clean(row && row[index]);
}

function columnIndexToLetters(columnIndex) {
  let value = columnIndex + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function syncDataset(dataset) {
  const client = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } });

  const vehicleRows = dataset.vehicles.map((vehicle) => {
    const vehicleCode = clean(vehicle.vehicleCode);
    if (!vehicleCode) throw new Error('Vehicle row is missing vehicleCode.');
    return {
      vehicle_code: vehicleCode,
      vin: nullable(vehicle.vin),
      source_header: nullable(vehicle.sourceHeader)
    };
  });

  const vehicleCodes = [...new Set(vehicleRows.map((vehicle) => vehicle.vehicle_code))];
  if (vehicleCodes.length !== vehicleRows.length) {
    throw new Error('Duplicate vehicleCode detected in sheet data.');
  }

  for (const batch of chunks(vehicleRows, 500)) {
    const { error } = await client.from('vehicles').upsert(batch, { onConflict: 'vehicle_code' });
    if (error) throw error;
  }

  const { data: storedVehicles, error: vehicleLookupError } = await client
    .from('vehicles')
    .select('id,vehicle_code')
    .in('vehicle_code', vehicleCodes);
  if (vehicleLookupError) throw vehicleLookupError;

  const vehicleIds = new Map((storedVehicles || []).map((vehicle) => [vehicle.vehicle_code, vehicle.id]));
  if (vehicleIds.size !== vehicleCodes.length) {
    throw new Error('Some imported vehicles could not be resolved in Supabase.');
  }

  const recordKeys = new Set();
  const versionRows = dataset.records.map((record) => {
    const vehicleCode = clean(record.vehicleCode);
    const vehicleId = vehicleIds.get(vehicleCode);
    const componentName = clean(record.componentName);
    const versionLabel = clean(record.versionLabel);
    if (!vehicleId || !componentName || !versionLabel) {
      throw new Error('Invalid component record found: ' + (vehicleCode || 'missing vehicleCode'));
    }

    const key = [vehicleId, componentName, versionLabel].join('__KEY__');
    if (recordKeys.has(key)) {
      throw new Error('Duplicate component version found: ' + vehicleCode + ' / ' + componentName + ' / ' + versionLabel);
    }
    recordKeys.add(key);

    return {
      vehicle_id: vehicleId,
      component_name: componentName,
      component_category: nullable(record.componentCategory),
      version_label: versionLabel,
      version_value: nullable(record.versionValue),
      note: nullable(record.note),
      source_row: Number.isInteger(record.sourceRow) ? record.sourceRow : null,
      source_column: nullable(record.sourceColumn)
    };
  });

  for (const batch of chunks([...vehicleIds.values()], 500)) {
    const { error } = await client.from('vehicle_component_versions').delete().in('vehicle_id', batch);
    if (error) throw error;
  }

  for (const batch of chunks(versionRows, 500)) {
    const { error } = await client
      .from('vehicle_component_versions')
      .upsert(batch, { onConflict: 'vehicle_id,component_name,version_label' });
    if (error) throw error;
  }

  return { vehicleCount: vehicleRows.length, recordCount: versionRows.length };
}
