import { defineConfig, devices } from '@playwright/test';
const testUrl = `http://127.0.0.1:${process.env.CLEARMAP_TEST_PORT ?? '1421'}`;
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: testUrl, viewport: { width: 1360, height: 940 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 940 } } }],
  webServer: { command: 'npm run build && npm run serve:test', url: testUrl, reuseExistingServer: false, timeout: 60000 },
});
