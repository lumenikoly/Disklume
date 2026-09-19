import { rm, mkdir, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const local = path.join(root, 'node_modules/typescript/bin/tsc');
const result = existsSync(local)
  ? spawnSync(process.execPath, [local, '-p', 'tsconfig.json'], { stdio: 'inherit' })
  : spawnSync('tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error || result.status !== 0) {
  console.error(result.error?.message ?? 'TypeScript: сборка не выполнена.');
  process.exit(result.status || 1);
}
await cp('assets', 'dist', { recursive: true });
console.log('ClearMap: интерфейс собран в dist/');
