import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
function build() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
}
if (!(await build())) process.exit(1);
const server = spawn(process.execPath, ['scripts/serve.mjs'], { stdio: 'inherit' });
let timer, running = false, pending = false;
async function rebuild() {
  if (running) { pending = true; return; }
  running = true;
  await build(); running = false;
  if (pending) { pending = false; await rebuild(); }
}
for (const directory of ['src', 'assets']) {
  watch(directory, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(rebuild, 180); });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.kill(); process.exit(); });
