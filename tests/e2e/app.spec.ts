import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('clearmap.locale'));
  await page.goto('/?__test=1');
  await expect(page.locator('#status-text')).toContainText('Готово');
  await expect(page.locator('#view-count')).toContainText('973');
});

test('language switch translates controls and preserves the current plan', async ({ page }) => {
  await page.click('#browse-files');
  await page.click('#mode-list');
  await page.click('tr[data-file-id="1"]');
  await page.keyboard.press('Delete');
  await expect(page.locator('#plan-count')).toContainText('1 файл');
  await page.click('#language');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#choose-folder')).toHaveAttribute('title', 'Choose folder (Ctrl / ⌘ + O)');
  await expect(page.locator('#folder-name')).toHaveText('Загрузки');
  await expect(page.locator('#dropzone-text')).toContainText('Add to removal list');
  await expect(page.locator('#plan-count')).toContainText('1 file');
  await page.click('#review-open');
  await expect(page.locator('#review')).toContainText('Move to Trash');
  await page.click('#review-cancel');
  await page.click('#help');
  await expect(page.locator('#message-dialog')).toContainText('Folders');
  await page.keyboard.press('Escape');
  await page.click('#language');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.locator('#plan-count')).toContainText('1 файл');
});

test('synthetic test backend never invokes native APIs', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.assign(window, { __TAURI__: { core: { invoke: () => { throw new Error('native API called'); } } } });
  });
  const page = await context.newPage();
  await page.goto('/?__test=1');
  await expect(page.locator('#status-text')).toContainText('Готово');
  await context.close();
});

test('map and controls fit supported window sizes', async ({ page }) => {
  for (const [width, height] of [[960,650],[1360,940],[1920,1080]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
});

test('search and selection open the correct inspector', async ({ page }) => {
  await page.click('#browse-files');
  await page.click('#mode-list');
  await page.locator('#search').fill('Летнее путешествие');
  await expect(page.locator('tr[data-file-id]')).toHaveCount(2);
  await page.click('tr[data-file-id="1"]');
  await expect(page.locator('#inspector')).toContainText('копия');
  await page.click('[data-action="open"]');
  await expect(page.locator('#toast-message')).toContainText('настоящие файлы не открываются');
  await page.click('[data-action="reveal"]');
  await expect(page.locator('#toast-message')).toContainText('не запускается');
});

test('Delete stages a plan; review cancellation does not delete', async ({ page }) => {
  await page.click('#browse-files');
  await page.click('#mode-list'); await page.click('tr[data-file-id="1"]');
  await page.keyboard.press('Delete');
  await expect(page.locator('#plan-count')).toContainText('1 файл');
  await expect(page.locator('#total-count')).toHaveText('973');
  await page.click('#review-open'); await page.click('#review-cancel');
  await expect(page.locator('#total-count')).toHaveText('973');
  await page.click('#review-open'); await page.click('[data-remove="1"]');
  await expect(page.locator('#review-confirm')).toBeDisabled();
});

test('confirmation removes only the chosen synthetic file', async ({ page }) => {
  await page.click('#browse-files');
  await page.click('#mode-list'); await page.click('tr[data-file-id="1"]'); await page.keyboard.press('Delete');
  await page.click('#review-open'); await page.click('#review-confirm');
  await expect(page.locator('#total-count')).toHaveText('972');
  await expect(page.locator('tr[data-file-id="1"]')).toHaveCount(0);
  await expect(page.locator('tr[data-file-id="0"]')).toHaveCount(1);
});

test('duplicates require an explicit check and filters compose', async ({ page }) => {
  await page.click('#find-duplicates');
  await expect(page.locator('#duplicate-badge')).toHaveText('2');
  await expect(page.locator('#status-text')).toContainText('Готово');
  await page.click('#filter-duplicates');
  await expect(page.locator('#view-count')).toHaveText(/^2 /);
  await page.click('#filter-screenshots');
  await expect(page.locator('#view-count')).toHaveText(/^0 /);
  await expect(page.locator('#empty-state')).toBeVisible();
});

test('help uses a native dialog and Escape closes it', async ({ page }) => {
  await page.click('#help');
  await expect(page.locator('#message-dialog')).toBeVisible();
  await expect(page.locator('#message-dialog')).toContainText('Папки');
  await page.keyboard.press('Escape');
  await expect(page.locator('#message-dialog')).not.toBeVisible();
});

test('folders show recursive sizes and navigate down and up without selecting directories', async ({ page }) => {
  await expect(page.locator('#browse-folders')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#file-list')).toBeVisible();
  const video = page.locator('.directory-link', { hasText: 'Видео' });
  await expect(video).toBeVisible();
  await expect(video.locator('xpath=ancestor::tr')).toContainText('29,2');
  await video.click();
  await expect(page.locator('#breadcrumbs')).toContainText('Видео');
  await expect(page.locator('tr[data-file-id="0"]')).toBeVisible();
  await expect(page.locator('tr[data-file-id="1"]')).toHaveCount(0);
  await page.locator('.directory-link', { hasText: 'Копии' }).click();
  await expect(page.locator('tr[data-file-id="1"]')).toBeVisible();
  await expect(page.locator('#actionbar')).not.toBeVisible();
  await page.click('tr[data-file-id="1"]');
  await expect(page.locator('#inspector')).toContainText('копия');
  await page.keyboard.press('Delete');
  await expect(page.locator('#plan-count')).toContainText('1 файл');
  await page.click('#review-open'); await page.click('#review-confirm');
  await expect(page.locator('#total-count')).toHaveText('972');
  await expect(page.locator('#empty-state')).toBeVisible();
  await page.locator('#breadcrumbs button', { hasText: 'Видео' }).click();
  await expect(page.locator('#view-count')).toContainText('14,6');
  await page.locator('#breadcrumbs button', { hasText: 'Загрузки' }).click();
  await expect(page.locator('#breadcrumbs')).toHaveText('Загрузки');
  await page.click('#browse-files');
  await expect(page.locator('#map-region')).toBeVisible();
  await expect(page.locator('#view-count')).toContainText('972');
});

test('context menu exposes file and folder system actions', async ({ page }) => {
  const fileRow = page.locator('#file-list tr[data-file-id]').first();
  await fileRow.click({ button: 'right' });
  await expect(page.locator('#context-menu')).toBeVisible();
  await expect(page.locator('#context-menu')).toContainText('Открыть файл');
  await expect(page.locator('#context-menu')).toContainText('Показать файл в Проводнике');
  await page.keyboard.press('Escape');
  await expect(page.locator('#context-menu')).toBeHidden();

  const directoryRow = page.locator('#file-list tr[data-directory-id]').first();
  await directoryRow.click({ button: 'right' });
  await expect(page.locator('#context-menu')).toBeVisible();
  await expect(page.locator('#context-menu')).toContainText('Показать папку в Проводнике');
});

test('folder filters, pagination and language stay in the current directory', async ({ page }) => {
  await page.click('#browse-folders');
  await page.locator('.directory-link', { hasText: 'Разное' }).click();
  await expect(page.locator('tr[data-file-id]')).toHaveCount(200);
  await page.click('[data-page="200"]');
  await expect(page.locator('#file-list .pagination')).toContainText('201');
  await page.locator('#search').fill('Документ');
  await expect(page.locator('tr[data-file-id]')).toHaveCount(120);
  await expect(page.locator('#breadcrumbs')).toContainText('Разное');
  await page.click('#language');
  await expect(page.locator('#browse-folders')).toHaveText('Folders');
  await expect(page.locator('#file-list thead')).toContainText('Share');
  await expect(page.locator('#breadcrumbs')).toContainText('Разное');
  await page.click('#clear-filters');
  await expect(page.locator('tr[data-file-id]')).toHaveCount(200);
  await expect(page.locator('#breadcrumbs')).toContainText('Разное');
  for (const [width, height] of [[960,650],[1360,900]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
  }
});

test('folder select-all selects only visible files and never child directories', async ({ page }) => {
  await page.click('#browse-folders');
  const visible = await page.locator('tr[data-file-id]').count();
  expect(visible).toBeGreaterThan(0);
  await page.locator('#browse-folders').focus();
  await page.keyboard.press('Control+a');
  await expect(page.locator('tr.selected')).toHaveCount(visible);
  await page.keyboard.press('Delete');
  await page.click('#review-open');
  await expect(page.locator('.review-row')).toHaveCount(visible);
  await expect(page.locator('#review-files')).not.toContainText('Летнее путешествие');
  await page.click('#review-cancel');
  await page.locator('.directory-link', { hasText: 'Видео' }).click();
  await page.locator('.directory-link', { hasText: 'Копии' }).click();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.locator('#breadcrumbs .current')).toHaveText('Видео');
});
