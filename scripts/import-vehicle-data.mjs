import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const sourcePath = args.find((arg) => arg !== '--replace') || process.env.VEHICLE_DATA_FILE;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!sourcePath) throw new Error('请提供数据文件路径，或设置 VEHICLE_DATA_FILE。');
if (!url || !serviceRoleKey) throw new Error('请设置 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY。');

const resolvedPath = path.resolve(sourcePath);
const source = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
if (!Array.isArray(source.vehicles) || !Array.isArray(source.records)) {
  throw new Error('数据文件必须包含 vehicles 和 records 数组。');
}

const client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
const text = (value) => value == null ? '' : String(value).trim();
const nullable = (value) => text(value) || null;
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const vehicleRows = source.vehicles.map((vehicle) => {
  const vehicleCode = text(vehicle.vehicleCode ?? vehicle.vehicle_code);
  if (!vehicleCode) throw new Error('发现缺少 vehicleCode 的车辆记录。');
  return {
    vehicle_code: vehicleCode,
    vin: nullable(vehicle.vin),
    source_header: nullable(vehicle.sourceHeader ?? vehicle.source_header)
  };
});

const vehicleCodes = [...new Set(vehicleRows.map((vehicle) => vehicle.vehicle_code))];
if (vehicleCodes.length !== vehicleRows.length) throw new Error('数据文件中存在重复 vehicleCode。');

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
if (vehicleIds.size !== vehicleCodes.length) throw new Error('部分车辆导入后未找到对应的数据库 ID。');

const recordKeys = new Set();
const versionRows = source.records.map((record) => {
  const vehicleCode = text(record.vehicleCode ?? record.vehicle_code);
  const vehicleId = vehicleIds.get(vehicleCode);
  const componentName = text(record.componentName ?? record.component_name);
  const versionLabel = text(record.versionLabel ?? record.version_label);
  if (!vehicleId || !componentName || !versionLabel) {
    throw new Error(`发现无效关联件记录：${vehicleCode || '缺少车辆编号'}。`);
  }
  const key = `${vehicleId}\u0000${componentName}\u0000${versionLabel}`;
  if (recordKeys.has(key)) throw new Error(`发现重复关联件版本记录：${vehicleCode} / ${componentName} / ${versionLabel}`);
  recordKeys.add(key);
  return {
    vehicle_id: vehicleId,
    component_name: componentName,
    component_category: nullable(record.componentCategory ?? record.component_category),
    version_label: versionLabel,
    version_value: nullable(record.versionValue ?? record.version_value),
    note: nullable(record.note),
    source_row: Number.isInteger(record.sourceRow ?? record.source_row) ? (record.sourceRow ?? record.source_row) : null,
    source_column: nullable(record.sourceColumn ?? record.source_column)
  };
});

if (replace) {
  for (const batch of chunks([...vehicleIds.values()], 500)) {
    const { error } = await client.from('vehicle_component_versions').delete().in('vehicle_id', batch);
    if (error) throw error;
  }
}

for (const batch of chunks(versionRows, 500)) {
  const { error } = await client
    .from('vehicle_component_versions')
    .upsert(batch, { onConflict: 'vehicle_id,component_name,version_label' });
  if (error) throw error;
}

console.log(`Imported ${vehicleRows.length} vehicles and ${versionRows.length} component version records.`);
console.log(replace ? 'Existing version records for imported vehicles were replaced.' : 'Existing matching records were updated; unmatched records were kept.');
