import { App } from './ui/app.js';
import { NativeBackend } from './bridge.js';
import { hydrateIcons } from './ui/icons.js';
import { errorMessage } from './format.js';
import { ui } from './i18n.js';
async function main(): Promise<void> {
  hydrateIcons();
  // Synthetic data is reachable only from the local test server and cannot be
  // enabled in the packaged application.
  const testMode = location.hostname === '127.0.0.1' && new URLSearchParams(location.search).get('__test') === '1';
  const backend = testMode ? new (await import('./demo.js')).DemoBackend() : new NativeBackend();
  const app = new App(backend);
  await app.start();
  window.addEventListener('pagehide', () => app.destroy(), { once: true });
}
main().catch((error: unknown) => {
  const area = document.createElement('p'); area.style.cssText = 'padding:24px;color:#efc3a2';
  area.textContent = ui`Не удалось запустить интерфейс: ${errorMessage(error)}`; document.body.append(area);
});
