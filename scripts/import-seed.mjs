import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error('请设置 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY');
const client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
const seedPath = process.env.SEED_FILE || process.argv[2];
if (!seedPath) throw new Error('请提供 SEED_FILE，指向本地完整 seed-data.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

for (const [sort_order, sheet] of seed.sheets.entries()) {
  const config = { key: `sheet-${sort_order + 1}`, name: sheet.name, columns: sheet.columns, sort_order };
  const { error: configError } = await client.from('sheet_configs').upsert(config);
  if (configError) throw configError;
  const rows = sheet.rows.map((row) => ({ sheet_key: config.key, row_index: row.rowIndex, cells: row.cells }));
  const { error: rowError } = await client.from('sheet_rows').upsert(rows, { onConflict: 'sheet_key,row_index' });
  if (rowError) throw rowError;
  console.log(`Imported ${sheet.name}: ${rows.length} rows / ${sheet.columns.length} columns`);
}
console.log('Import complete.');

