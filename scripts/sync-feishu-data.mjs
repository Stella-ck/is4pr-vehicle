import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const exportPath = path.resolve(process.env.FEISHU_EXPORT_PATH || path.join(repoRoot, 'data', 'feishu-linked-parts.xlsx'));
const outputJsonPath = path.resolve(process.env.VEHICLE_DATA_FILE || path.join(repoRoot, 'data', 'vehicle-components.local.json'));
const buildScriptPath = path.join(repoRoot, 'scripts', 'build-vehicle-data.ps1');
const exportScriptPath = path.join(repoRoot, 'scripts', 'export-feishu-sheet.mjs');
const importScriptPath = path.join(repoRoot, 'scripts', 'import-vehicle-data.mjs');

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      stdio: 'inherit',
      ...options
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

await fs.mkdir(path.dirname(exportPath), { recursive: true });
await fs.mkdir(path.dirname(outputJsonPath), { recursive: true });

try {
  await runCommand(process.execPath, [exportScriptPath, exportPath]);
  await runCommand('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', buildScriptPath,
    '-SourceWorkbook', exportPath,
    '-OutputPath', outputJsonPath
  ]);
  await runCommand(process.execPath, [importScriptPath, outputJsonPath, '--replace']);
} finally {
  await fs.rm(exportPath, { force: true });
}
