import { test, expect, type Page } from '@playwright/test';

async function copies(page: Page) {
  await page.locator('.directory-link', { hasText: 'Видео' }).click();
  await page.locator('.directory-link', { hasText: 'Копии' }).click();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('clearmap.locale'));
  await page.goto('/?__test=1');
  await expect(page.locator('#status-text')).toContainText('Готово');
  await expect(page.locator('#view-count')).toContainText('973');
});

test('one screen shows both directory map and size-sorted list', async ({ page }) => {
  await expect(page.locator('#treemap')).toBeVisible();
  await expect(page.locator('#file-list')).toBeVisible();
  await expect(page.locator('#treemap .tile').first()).toContainText('Видео');
  await expect(page.locator('.directory-link').first()).toHaveText('Видео›');
  await expect(page.locator('#actionbar')).toBeHidden();
  await expect(page.locator('#help, #filter-old, #find-duplicates, #mode-map, #metric')).toHaveCount(0);
});

test('map opens folders, list selects files and breadcrumbs return up', async ({ page }) => {
  await page.locator('#treemap .tile', { hasText: 'Видео' }).click();
  await expect(page.locator('#breadcrumbs .current')).toHaveText('Видео');
  await expect(page.locator('tr[data-file-id="0"]')).toBeVisible();
  await page.locator('.directory-link', { hasText: 'Копии' }).click();
  await page.locator('#treemap [data-file-id="1"]').click();
  await expect(page.locator('#inspector')).toContainText('копия');
  await expect(page.locator('tr[data-file-id="1"]')).toHaveClass(/selected/);
  await page.locator('#breadcrumbs button', { hasText: 'Видео' }).click();
  await expect(page.locator('#inspector')).toBeHidden();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.locator('#breadcrumbs .current')).toHaveText('Загрузки');
});

test('search stays in current directory and clear restores results', async ({ page }) => {
  await page.locator('.directory-link', { hasText: 'Разное' }).click();
  await page.locator('#search').fill('Документ');
  await expect(page.locator('tr[data-file-id]')).toHaveCount(120);
  await expect(page.locator('#breadcrumbs')).toContainText('Разное');
  await page.locator('#search').fill('нет-такого-файла');
  await expect(page.locator('#empty-state')).toContainText('Ничего не найдено');
  await page.click('#clear-search');
  await expect(page.locator('tr[data-file-id]')).toHaveCount(200);
  await expect(page.locator('#empty-state')).toBeHidden();
});

test('open and reveal remain synthetic in the test backend', async ({ page }) => {
  await copies(page);
  await page.click('tr[data-file-id="1"]');
  await page.locator('#treemap [data-file-id="1"]').dblclick();
  await expect(page.locator('#toast-message')).toContainText('настоящие файлы не открываются');
  await page.click('[data-action="reveal"]');
  await expect(page.locator('#toast-message')).toContainText('не запускается');
});

test('trash opens review directly and cancellation keeps files untouched', async ({ page }) => {
  await copies(page); await page.click('tr[data-file-id="1"]');
  await page.click('[data-action="trash"]');
  await expect(page.locator('#review')).toBeVisible();
  await expect(page.locator('#review-files')).toContainText('Летнее путешествие — копия.mov');
  await expect(page.locator('#total-count')).toHaveText('973');
  await page.click('#review-cancel');
  await expect(page.locator('tr[data-file-id="1"]')).toBeVisible();
  await expect(page.locator('#plan-count')).toContainText('1 файл');
  await page.click('#review-open'); await page.click('[data-remove="1"]');
  await expect(page.locator('#review-confirm')).toBeDisabled();
});

test('Delete requires confirmation and removes only selected synthetic file', async ({ page }) => {
  await copies(page); await page.click('tr[data-file-id="1"]'); await page.keyboard.press('Delete');
  await expect(page.locator('#review')).toBeVisible();
  await expect(page.locator('#total-count')).toHaveText('973');
  await page.click('#review-confirm');
  await expect(page.locator('#total-count')).toHaveText('972');
  await expect(page.locator('#empty-state')).toContainText('Папка пуста');
  await expect(page.locator('#inspector')).toBeHidden();
  await page.locator('#breadcrumbs button', { hasText: 'Видео' }).click();
  await expect(page.locator('#current-size')).toContainText('14,6');
  await expect(page.locator('tr[data-file-id="0"]')).toBeVisible();
});

test('Escape cancels review and staged plan can be cleared', async ({ page }) => {
  await copies(page); await page.click('tr[data-file-id="1"]'); await page.keyboard.press('Delete');
  await expect(page.locator('#review')).toBeVisible(); await page.keyboard.press('Escape');
  await page.click('#plan-clear');
  await expect(page.locator('#actionbar')).toBeHidden();
  await expect(page.locator('#total-count')).toHaveText('973');
  await expect(page.locator('#treemap .planned')).toHaveCount(0);
});

test('language switch preserves directory, filenames, selection and plan', async ({ page }) => {
  await copies(page); await page.click('tr[data-file-id="1"]'); await page.keyboard.press('Delete');
  await expect(page.locator('#review')).toBeVisible(); await page.click('#review-cancel');
  await page.click('#language');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#choose-folder')).toHaveAttribute('title', 'Choose folder (Ctrl / ⌘ + O)');
  await expect(page.locator('#breadcrumbs .current')).toHaveText('Копии');
  await expect(page.locator('#inspector')).toContainText('Летнее путешествие — копия.mov');
  await expect(page.locator('[data-action="trash"]')).toHaveText('Move to Trash…');
  await expect(page.locator('#plan-count')).toContainText('1 file');
  await page.click('#review-open'); await expect(page.locator('#review')).toContainText('Move to Trash');
  await page.click('#review-cancel'); await page.click('#language');
  await expect(page.locator('#plan-count')).toContainText('1 файл');
});

test('map and controls fit supported sizes with inspector and review', async ({ page }) => {
  await page.click('tr[data-file-id="2"]');
  for (const [width, height] of [[960,650],[1360,940],[1920,1080]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect(page.locator('[data-action="trash"]')).toBeInViewport();
    await expect(page.locator('#treemap .tile').first()).toBeInViewport();
  }
});

test('pagination keeps map proportional to the whole folder and bounded', async ({ page }) => {
  await page.locator('.directory-link', { hasText: 'Разное' }).click();
  await expect(page.locator('tr[data-file-id]')).toHaveCount(200);
  await expect(page.locator('#treemap .remainder')).toHaveCount(1);
  expect(await page.locator('#treemap .tile').count()).toBeLessThanOrEqual(201);
  const area = await page.locator('#treemap .remainder').evaluate(tile => {
    const rect = tile.getBoundingClientRect(), parent = tile.parentElement!.getBoundingClientRect();
    return rect.width * rect.height / (parent.width * parent.height) * 100;
  });
  const label = await page.locator('#treemap .remainder').getAttribute('title');
  const percent = Number(label!.split(' · ').at(-1)!.replace('%', '').replace(',', '.'));
  expect(area).toBeCloseTo(percent, 0);
  await page.locator('#treemap .remainder').click();
  await expect(page.locator('#file-list .pagination')).toContainText('201');
  await expect(page.locator('#breadcrumbs .current')).toHaveText('Разное');
});

test('select-all only stages visible files, never directories or hidden pages', async ({ page }) => {
  const visible = await page.locator('tr[data-file-id]').count();
  await page.locator('tr[data-file-id] input').first().focus(); await page.keyboard.press('Control+a');
  await expect(page.locator('tr.selected')).toHaveCount(visible);
  await page.keyboard.press('Delete');
  await expect(page.locator('#review')).toBeVisible();
  await expect(page.locator('.review-row')).toHaveCount(visible);
  await expect(page.locator('#review-files')).not.toContainText('Летнее путешествие');
  await page.click('#review-cancel');
  await page.locator('.directory-link', { hasText: 'Разное' }).click();
  await page.locator('#rescan').focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
  await expect(page.locator('#review')).toBeVisible();
  // Existing staged root files + this page, never the other 640 files.
  await expect(page.locator('#review-summary')).toContainText(String(visible + 200));
});

test('context menus offer basic file actions and safe folder navigation', async ({ page }) => {
  await page.locator('#file-list tr[data-file-id]').first().click({ button: 'right' });
  await expect(page.locator('#context-menu')).toContainText('Открыть файл');
  await expect(page.locator('#context-menu')).toContainText('Показать файл в Проводнике');
  await expect(page.locator('#context-menu')).toContainText('В Корзину…');
  await page.keyboard.press('Escape');
  await expect(page.locator('#context-menu')).toBeHidden();
  await page.locator('#treemap .tile', { hasText: 'Видео' }).click({ button: 'right' });
  await expect(page.locator('#context-menu')).toContainText('Показать папку в Проводнике');
  await expect(page.locator('#context-menu')).not.toContainText('Корзину');
  await page.click('[data-context-action="browse"]');
  await expect(page.locator('#breadcrumbs .current')).toHaveText('Видео');
});

test('executable opening still requires separate confirmation', async ({ page }) => {
  await page.click('tr[data-file-id="7"]'); await page.click('[data-action="open"]');
  await expect(page.locator('#message-dialog')).toContainText('Открыть исполняемый файл?');
  await page.click('#message-cancel');
  await expect(page.locator('#message-dialog')).toBeHidden();
  await expect(page.locator('#toast')).toBeHidden();
});

test('synthetic test backend never invokes native APIs', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => Object.assign(window, { __TAURI__: { core: { invoke: () => { throw new Error('native API called'); } } } }));
  const page = await context.newPage(); await page.goto('/?__test=1');
  await expect(page.locator('#status-text')).toContainText('Готово'); await context.close();
});

test('zero-byte files stay available in the list without invented area', async ({ page }) => {
  await expect(page.locator('tr[data-file-id="972"]')).toBeVisible();
  await expect(page.locator('#treemap [data-file-id="972"]')).toHaveCount(0);
  await page.click('tr[data-file-id="972"]');
  await expect(page.locator('#inspector .file-size')).toContainText('0 Б');
  await page.locator('#search').fill('Пустой файл');
  await expect(page.locator('#zero-state')).toBeVisible();
  await expect(page.locator('#treemap .tile')).toHaveCount(0);
  await expect(page.locator('#size-label')).toHaveText('НАЙДЕНО В ПАПКЕ');
});
