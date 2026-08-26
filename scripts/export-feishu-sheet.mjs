import fs from 'node:fs/promises';
import path from 'node:path';

const outputArg = process.argv[2] || process.env.FEISHU_EXPORT_PATH;
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const sheetToken = process.env.FEISHU_SHEET_TOKEN;
const pollIntervalMs = Number(process.env.FEISHU_EXPORT_POLL_MS || 3000);
const pollTimeoutMs = Number(process.env.FEISHU_EXPORT_TIMEOUT_MS || 120000);

if (!outputArg) {
  throw new Error('Please provide an output path or set FEISHU_EXPORT_PATH.');
}
if (!appId || !appSecret || !sheetToken) {
  throw new Error('Please set FEISHU_APP_ID, FEISHU_APP_SECRET, and FEISHU_SHEET_TOKEN.');
}

const outputPath = path.resolve(outputArg);
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const text = (value) => value == null ? '' : String(value).trim();

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    throw new Error(`Feishu API request failed (${response.status}): ${raw}`);
  }
  if (payload && typeof payload.code !== 'undefined' && payload.code !== 0) {
    throw new Error(`Feishu API error ${payload.code}: ${payload.msg || raw}`);
  }

  return payload;
}

async function getTenantAccessToken() {
  const payload = await requestJson(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    }
  );

  const token = text(payload?.tenant_access_token);
  if (!token) throw new Error('Feishu tenant_access_token is empty.');
  return token;
}

async function createExportTask(accessToken) {
  const payload = await requestJson(
    'https://open.feishu.cn/open-apis/drive/v1/export_tasks',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        token: sheetToken,
        type: 'sheet',
        file_extension: 'xlsx'
      })
    }
  );

  const ticket = text(payload?.data?.ticket || payload?.data?.job_id || payload?.ticket);
  if (!ticket) throw new Error('Feishu export task ticket is empty.');
  return ticket;
}

function resolveExportResult(payload) {
  const data = payload?.data || {};
  const result = data?.result || data;
  const statusValue = result?.job_status ?? data?.job_status ?? result?.status ?? data?.status ?? '';
  const status = String(statusValue).toLowerCase();
  const fileToken = text(
    result?.file_token ||
    data?.file_token ||
    result?.file?.token ||
    data?.file?.token
  );
  const fileName = text(
    result?.file_name ||
    data?.file_name ||
    result?.file?.name ||
    data?.file?.name
  );
  const jobErrorMsg = text(result?.job_error_msg || data?.job_error_msg);
  return { status, fileToken, fileName, jobErrorMsg, raw: payload };
}

function isFinished(status, fileToken) {
  if (fileToken) return true;
  return ['success', 'succeeded', 'completed', 'done', 'finished', '0'].includes(status);
}

function isPending(status) {
  return ['', 'new', 'processing', 'pending', '1', '2'].includes(status);
}

function isFailed(status) {
  return !isPending(status) && !isFinished(status);
}

async function waitForExport(accessToken, ticket) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < pollTimeoutMs) {
    const exportStatusUrl = new URL(`https://open.feishu.cn/open-apis/drive/v1/export_tasks/${ticket}`);
    exportStatusUrl.searchParams.set('token', sheetToken);
    const payload = await requestJson(
      exportStatusUrl,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const result = resolveExportResult(payload);
    if (isFinished(result.status, result.fileToken)) return result;
    if (isFailed(result.status)) {
      const details = result.jobErrorMsg ? `${result.jobErrorMsg}: ` : '';
      throw new Error(`Feishu export task failed: ${details}${JSON.stringify(result.raw)}`);
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for Feishu export task after ${pollTimeoutMs}ms.`);
}

async function downloadExport(accessToken, fileToken) {
  const response = await fetch(
    `https://open.feishu.cn/open-apis/drive/v1/files/${fileToken}/download`,
    { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'follow' }
  );

  if (!response.ok) {
    throw new Error(`Failed to download exported sheet (${response.status}).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
}

const accessToken = await getTenantAccessToken();
const ticket = await createExportTask(accessToken);
const exportResult = await waitForExport(accessToken, ticket);
if (!exportResult.fileToken) {
  throw new Error(`Feishu export finished without file token: ${JSON.stringify(exportResult.raw)}`);
}

await downloadExport(accessToken, exportResult.fileToken);

console.log(`Exported Feishu sheet ${sheetToken} to ${outputPath}`);
if (exportResult.fileName) console.log(`Export file name: ${exportResult.fileName}`);
