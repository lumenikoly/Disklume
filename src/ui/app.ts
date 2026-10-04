import type { Backend, DirectoryEntry, FileDetail, PlanPage, Status, View } from '../types.js';
import { busy, defaultFilter } from '../types.js';
import { basename, colors, errorMessage, escapeHtml as esc, fileWord, formatBytes, number } from '../format.js';
import { initLocale, intlLocale, locale, setLocale, ui } from '../i18n.js';
import { treemap } from '../map/treemap.js';
import { el, disable, on, show, text } from './dom.js';
import { icon } from './icons.js';
import { MessageDialog } from './dialog.js';
import { revealLabel } from '../platform.js';

export class App {
  private status: Status | null = null;
  private view: View | null = null;
  private filter = { ...defaultFilter(), folders: true };
  private selection = new Set<number>();
  private planned = new Set<number>();
  private detail: FileDetail | null = null;
  private offset = 0;
  private message = new MessageDialog();
  private timer: ReturnType<typeof setInterval> | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private mutation = false;
  private queryVersion = 0;
  private queryRunning = false;
  private detailVersion = 0;
  private reviewPage: PlanPage | null = null;
  private reviewLoading = false;
  private contextTarget: { fileId: number } | { directoryId: number } | null = null;
  private events = new AbortController();
  private resize = new ResizeObserver(() => this.renderMap());
  constructor(private backend: Backend) {
    initLocale(); this.bind(); this.resize.observe(el('treemap'));
  }
  async start(): Promise<void> {
    await this.syncLanguage();
    if (this.backend.demo) await this.activate(await this.backend.chooseFolder());
    else { const current = await this.backend.currentStatus(); if (current) await this.activate(current.scanId); }
    this.timer = setInterval(() => {
      if (this.status && busy(this.status.phase) && !this.polling) void this.refreshStatus().catch((e: unknown) => this.notify(errorMessage(e), true));
    }, 500);
  }
  destroy(): void {
    this.events.abort(); this.resize.disconnect(); clearInterval(this.timer); clearTimeout(this.searchTimer); clearTimeout(this.toastTimer);
  }
  private bind(): void {
    on('choose-folder', () => void this.choose(false)); on('welcome-choose', () => void this.choose(false));
    on('rescan', () => void this.choose(true)); on('language', () => void this.changeLanguage());
    on('cancel-job', () => void this.act(async id => this.backend.cancel(id), true));
    on('clear-search', () => { clearTimeout(this.searchTimer); el<HTMLInputElement>('search').value = ''; this.changeFilter(''); });
    on('review-open', () => void this.openReview());
    on('plan-clear', () => void this.act(async id => { await this.backend.planClear(id); this.planned.clear(); }));
    for (const id of ['review-close', 'review-cancel']) on(id, () => { if (!this.mutation) el<HTMLDialogElement>('review').close(); });
    el<HTMLDialogElement>('review').addEventListener('cancel', event => { if (this.mutation) event.preventDefault(); });
    on('review-confirm', () => void this.execute()); on('show-issues', () => void this.showIssues());
    on('toast-close', () => show('toast', false));
    el<HTMLInputElement>('search').addEventListener('input', () => {
      clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.changeFilter(el<HTMLInputElement>('search').value.trim()), 200);
    });
    document.addEventListener('keydown', event => this.keydown(event), { signal: this.events.signal });
    el('file-list').addEventListener('click', event => {
      const target = event.target as Element;
      const reveal = target.closest<HTMLButtonElement>('[data-reveal-directory]');
      if (reveal) { void this.act(async id => this.backend.revealDirectory(id, Number(reveal.dataset.revealDirectory))); return; }
      const page = target.closest<HTMLButtonElement>('[data-page]');
      if (page) { this.offset = Number(page.dataset.page); this.select([], false); void this.loadView(); el('file-list').scrollTop = 0; return; }
      const directory = target.closest<HTMLButtonElement>('[data-directory]');
      if (directory) { this.enterDirectory(Number(directory.dataset.directory)); return; }
      const row = target.closest<HTMLElement>('[data-file-id]');
      if (row) this.select([Number(row.dataset.fileId)], target instanceof HTMLInputElement || event.ctrlKey || event.metaKey);
    });
    el('file-list').addEventListener('dblclick', event => {
      const row = (event.target as Element).closest<HTMLElement>('[data-file-id]');
      if (row && !(event.target instanceof HTMLInputElement)) void this.openFile(Number(row.dataset.fileId));
    });
    for (const surface of ['file-list', 'treemap']) el(surface).addEventListener('contextmenu', event => {
      const row = (event.target as Element).closest<HTMLElement>('[data-file-id], [data-directory-id]');
      if (!row) return; event.preventDefault();
      if (row.dataset.fileId !== undefined) this.showContextMenu({ fileId: Number(row.dataset.fileId) }, event.clientX, event.clientY);
      else if (row.dataset.directoryId !== undefined) this.showContextMenu({ directoryId: Number(row.dataset.directoryId) }, event.clientX, event.clientY);
    });
    el('treemap').addEventListener('click', event => {
      const tile = (event.target as Element).closest<HTMLElement>('.tile'); if (!tile) return;
      if (tile.dataset.directoryId !== undefined) this.enterDirectory(Number(tile.dataset.directoryId));
      else if (tile.dataset.fileId !== undefined) this.select([Number(tile.dataset.fileId)], event.ctrlKey || event.metaKey);
      else if (tile.dataset.page !== undefined) { this.offset = Number(tile.dataset.page); this.select([], false); void this.loadView(); }
    });
    el('treemap').addEventListener('dblclick', event => {
      const tile = (event.target as Element).closest<HTMLElement>('[data-file-id]');
      if (tile) void this.openFile(Number(tile.dataset.fileId));
    });
    el('context-menu').addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-context-action]'), target = this.contextTarget;
      if (!button || !target) return; this.hideContextMenu();
      if (button.dataset.contextAction === 'open' && 'fileId' in target) void this.openFile(target.fileId);
      if (button.dataset.contextAction === 'trash' && 'fileId' in target) void this.addToPlan([target.fileId]);
      if (button.dataset.contextAction === 'reveal-file' && 'fileId' in target) void this.act(async id => this.backend.reveal(id, target.fileId));
      if (button.dataset.contextAction === 'reveal-directory' && 'directoryId' in target) void this.act(async id => this.backend.revealDirectory(id, target.directoryId));
      if (button.dataset.contextAction === 'browse' && 'directoryId' in target) this.enterDirectory(target.directoryId);
    });
    document.addEventListener('pointerdown', event => { if (!(event.target as Element).closest('#context-menu')) this.hideContextMenu(); }, { signal: this.events.signal });
    window.addEventListener('blur', () => this.hideContextMenu(), { signal: this.events.signal });
    window.addEventListener('resize', () => this.hideContextMenu(), { signal: this.events.signal });
    el('inspector').addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
      const id = this.detail?.file.id;
      if (button.dataset.action === 'close') this.select([], false);
      if (button.dataset.action === 'open' && id !== undefined) void this.openFile(id);
      if (button.dataset.action === 'reveal' && id !== undefined) void this.act(async scanId => this.backend.reveal(scanId, id));
      if (button.dataset.action === 'trash') void this.addToPlan([...this.selection]);
    });
    el('review-files').addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-remove]'); if (button) void this.removeFromReview(Number(button.dataset.remove));
    });
    el('review-pagination').addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-review-page]'); if (button) void this.loadReview(Number(button.dataset.reviewPage));
    });
    el('breadcrumbs').addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-directory]'); if (button) this.enterDirectory(Number(button.dataset.directory));
    });
  }
  private async choose(rescan: boolean): Promise<void> {
    if (this.mutation || busy(this.status?.phase)) return;
    this.mutation = true; this.renderStatus();
    try {
      if (this.status?.planCount && !(await this.message.ask(ui('Сбросить список удаления?'), ui('При смене папки или повторном сканировании подготовленный список будет очищен. Сами файлы останутся на месте.'), ui('Сбросить список')))) return;
      // The native picker clears the old plan only after a new folder is chosen.
      // This keeps a plan intact when the user cancels the picker.
      const id = rescan && this.status ? await this.backend.rescan(this.status.scanId, Boolean(this.status.planCount)) : await this.backend.chooseFolder(Boolean(this.status?.planCount));
      if (id !== null && this.status?.planCount) this.planned.clear();
      if (id !== null) await this.activate(id);
    } catch (error) { this.notify(errorMessage(error), true); }
    finally { this.mutation = false; this.renderStatus(); }
  }
  private async activate(id: number | null): Promise<void> {
    if (id === null) return;
    this.status = await this.backend.status(id); this.view = null;
    this.filter = { ...defaultFilter(), folders: true }; this.offset = 0;
    this.planned.clear(); this.selection.clear(); this.detail = null; this.detailVersion++;
    el<HTMLInputElement>('search').value = '';
    show('welcome', false); show('workspace', true);
    this.renderStatus();
    if (this.status.planCount) {
      await this.syncPlan(id);
    }
    this.renderFilters(); this.renderInspector(); this.renderStatus(); await this.loadView();
  }
  private async refreshStatus(): Promise<void> {
    if (!this.status || this.polling) return;
    this.polling = true; const id = this.status.scanId;
    try {
      const status = await this.backend.status(id);
      if (this.status?.scanId !== id) return;
      const old = this.status; this.status = status;
      if (old.phase === 'deleting' && !busy(status.phase)) {
        this.selection.clear(); this.detail = null; this.detailVersion++;
        this.planned.clear();
        if (status.planCount) {
          await this.syncPlan(id);
        }
        this.renderInspector();
        const result = status.operation;
        this.notify(`${ui('В Корзину перенесено')}: ${number(result.succeeded)} ${fileWord(result.succeeded)}.${result.failed ? ui` Не удалось: ${result.failed}. Подробнее — в отчёте.` : ''}${status.phase === 'cancelled' ? ui(' Оставшиеся действия остановлены.') : ''}`, result.failed > 0);
      }
      this.renderStatus();
      if (status.revision !== this.view?.revision) await this.loadView();
    } finally { this.polling = false; }
  }
  /** Only one query is in flight. New filters supersede old requests; stale responses never render. */
  private async loadView(): Promise<void> {
    this.queryVersion++;
    if (this.queryRunning || !this.status) return;
    this.queryRunning = true;
    try {
      let applied = -1;
      while (applied !== this.queryVersion && this.status) {
        const version = this.queryVersion, id = this.status.scanId;
        const filter = structuredClone(this.filter), offset = this.offset;
        const view = await this.backend.query(id, filter, offset);
        applied = version;
        if (version !== this.queryVersion || id !== this.status.scanId) continue;
        this.view = view; this.offset = view.offset; this.renderMap();
        this.renderList(); this.renderFilters(); this.renderEmpty(); this.renderSelection();
      }
    } catch (error) { this.notify(errorMessage(error), true); }
    finally { this.queryRunning = false; }
  }
  private changeFilter(search: string): void {
    this.filter.text = search; this.offset = 0; this.select([], false); this.renderFilters(); void this.loadView();
  }
  private renderFilters(): void {
    show('clear-search', Boolean(this.filter.text));
    text('size-label', this.filter.text ? ui('НАЙДЕНО В ПАПКЕ') : ui('ЗАНЯТО В ПАПКЕ'));
    if (this.view) {
      const path = this.view.breadcrumbs;
      el('breadcrumbs').innerHTML = path.map((entry, i) => `${i ? '<span class="crumb-separator">/</span>' : ''}${i === path.length - 1 ? `<span class="current" title="${esc(entry.name)}">${esc(entry.name)}</span>` : `<button data-directory="${entry.id}" title="${esc(entry.name)}">${esc(entry.name)}</button>`}`).join('');
      text('current-size', formatBytes(this.view.bytes));
      text('view-count', `${number(this.view.total)} ${fileWord(this.view.total)}`);
    }
  }
  private renderStatus(): void {
    const status = this.status, working = busy(status?.phase), locked = working || this.mutation;
    disable('choose-folder', locked); disable('welcome-choose', this.mutation); disable('rescan', !status || locked);
    disable('plan-clear', locked); disable('review-open', locked); disable('cancel-job', this.mutation);
    if (!status) return;
    text('folder-name', basename(status.root)); text('folder-path', status.root); el('folder-path').title = status.root;
    text('total-count', number(status.files));
    show('cancel-job', working); el('status-indicator').classList.toggle('working', working);
    let line = ui('Готово');
    if (status.phase === 'scanning') line = ui`Сканирование · ${number(status.files)} ${fileWord(status.files)}`;
    else if (status.phase === 'hashing') line = ui('Поиск совпадений');
    else if (status.phase === 'deleting') line = ui`В Корзину · ${status.operation.completed} / ${status.operation.total}`;
    else if (status.phase === 'cancelled') line = ui('Остановлено · результаты могут быть неполными');
    else if (status.phase === 'failed') line = ui('Операция не завершена · откройте отчёт');
    text('status-text', line);
    const issues = status.issuesCount + status.operation.failed;
    text('show-issues', ui`Отчёт${issues ? ': ' + number(issues) : ''}`);
    show('show-issues', issues > 0 || status.skippedLinks > 0 || status.skippedSpecial > 0);
    show('actionbar', status.planCount > 0);
    text('plan-count', ui`${number(status.planCount)} ${fileWord(status.planCount)} в списке удаления`);
    this.renderSelection(); this.renderInspector();
    el('file-list').querySelectorAll<HTMLButtonElement>('[data-reveal-directory]').forEach(button => { button.disabled = locked; });
  }
  private renderEmpty(): void {
    show('empty-state', this.view?.entryTotal === 0);
    text('empty-message', this.status?.phase === 'scanning' ? ui('Сканирование продолжается…') : this.filter.text ? ui('Ничего не найдено') : ui('Папка пуста.'));
    show('zero-state', Boolean(this.view?.entryTotal && !this.view.bytes));
  }
  private enterDirectory(directoryId: number): void {
    this.hideContextMenu(); this.filter.directoryId = directoryId; this.offset = 0; this.select([], false); void this.loadView(); el('file-list').scrollTop = 0;
  }
  private renderMap(): void {
    if (!this.view) return;
    const surface = el('treemap'), width = surface.clientWidth, height = surface.clientHeight;
    if (!width || !height) return;
    const entries: (DirectoryEntry & { remainder?: boolean })[] = [...this.view.entries];
    const rest = this.view.bytes - entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (rest > 0) entries.push({ name: ui('На других страницах'), bytes: rest, count: 0, directoryId: null, file: null, remainder: true });
    const nextPage = this.offset + 200 < this.view.entryTotal ? this.offset + 200 : 0;
    surface.innerHTML = treemap(entries, width, height).map(tile => {
      const entry = tile.item, share = this.view!.bytes ? entry.bytes / this.view!.bytes * 100 : 0;
      const color = entry.remainder ? '#e6e8ef' : entry.file ? fileColor(entry.file.category) : folderColors[(entry.directoryId ?? 0) % folderColors.length]!;
      const target = entry.directoryId !== null ? `data-directory-id="${entry.directoryId}"` : entry.file ? `data-file-id="${entry.file.id}"` : `data-page="${nextPage}"`;
      const tiny = tile.width < 65 || tile.height < 48;
      return `<button class="tile ${entry.file && this.selection.has(entry.file.id) ? 'selected' : ''} ${entry.file && this.planned.has(entry.file.id) ? 'planned' : ''} ${entry.remainder ? 'remainder' : ''} ${tiny ? 'tiny' : ''}" ${target} style="left:${tile.x / width * 100}%;top:${tile.y / height * 100}%;width:${tile.width / width * 100}%;height:${tile.height / height * 100}%;--tile-color:${color}" title="${esc(entry.name)} · ${formatBytes(entry.bytes)} · ${share.toLocaleString(intlLocale(), { maximumFractionDigits: 1 })}%" aria-label="${esc(entry.name)} · ${formatBytes(entry.bytes)}"><span class="tile-content">${entry.directoryId !== null ? icon('folder') : ''}<strong>${esc(entry.name)}</strong><span>${formatBytes(entry.bytes)}</span>${tile.height > 125 && tile.width > 140 ? `<small>${share.toLocaleString(intlLocale(), { maximumFractionDigits: 1 })}%</small>` : ''}</span></button>`;
    }).join('');
  }
  private showContextMenu(target: { fileId: number } | { directoryId: number }, x: number, y: number): void {
    if (!this.status || busy(this.status.phase) || this.mutation) return;
    this.contextTarget = target;
    const menu = el('context-menu');
    if ('fileId' in target) {
      this.select([target.fileId], false);
      menu.innerHTML = ui`<button role="menuitem" data-context-action="open">${icon('open')}Открыть файл</button><button role="menuitem" data-context-action="reveal-file">${icon('folder')}${revealLabel('file')}</button><button role="menuitem" class="danger-text" data-context-action="trash">${icon('trash')}В Корзину…</button>`;
    } else {
      menu.innerHTML = ui`<button role="menuitem" data-context-action="browse">${icon('folder')}Открыть папку</button><button role="menuitem" data-context-action="reveal-directory">${icon('folder')}${revealLabel('folder')}</button>`;
    }
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button')?.focus();
  }
  private hideContextMenu(): void {
    const menu = el('context-menu');
    menu.hidden = true;
    this.contextTarget = null;
  }
  private renderList(): void {
    if (!this.view) return;
    const view = this.view;
    el('file-list').innerHTML = ui`<table><thead><tr><th></th><th>Имя</th><th>Размер</th><th></th></tr></thead><tbody>${view.entries.map(entry => {
      const file = entry.file, share = view.bytes ? entry.bytes / view.bytes * 100 : 0;
      return `<tr ${file ? `data-file-id="${file.id}"` : `data-directory-id="${entry.directoryId}"`} class="${file && this.selection.has(file.id) ? 'selected' : ''} ${file && this.planned.has(file.id) ? 'planned' : ''}"><td>${file ? `<input type="checkbox" aria-label="${ui('Выбрать')} ${esc(file.name)}" ${this.selection.has(file.id) ? 'checked' : ''}>` : icon('folder')}</td><td>${entry.directoryId !== null ? `<button class="directory-link" data-directory="${entry.directoryId}" title="${esc(entry.name)}">${esc(entry.name)}<span>›</span></button>` : `<button class="file-link" title="${esc(entry.name)}">${esc(entry.name)}</button>`}<div class="size-share"><span class="size-bar" style="width:${Math.min(100, share)}%;background:${file ? fileColor(file.category) : folderColors[(entry.directoryId ?? 0) % folderColors.length]!}"></span></div></td><td class="size-cell">${formatBytes(entry.bytes)}<small>${share.toLocaleString(intlLocale(), { maximumFractionDigits: 1 })}%</small></td><td>${entry.directoryId !== null ? `<button class="icon-button row-reveal" data-reveal-directory="${entry.directoryId}" ${this.mutation || busy(this.status?.phase) ? 'disabled' : ''} title="${revealLabel('folder')}" aria-label="${revealLabel('folder')}: ${esc(entry.name)}">${icon('open')}</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table>${this.pagination(view.offset, view.entryTotal, 'page')}`;
  }
  private pagination(offset: number, count: number, attribute: string): string {
    if (count <= 200) return '';
    return ui`<div class="pagination"><button data-${attribute}="${Math.max(0, offset - 200)}" ${offset === 0 ? 'disabled' : ''}>← Назад</button><span>${number(offset + 1)}–${number(Math.min(count, offset + 200))} из ${number(count)}</span><button data-${attribute}="${offset + 200}" ${offset + 200 >= count ? 'disabled' : ''}>Далее →</button></div>`;
  }
  private select(ids: number[], additive: boolean): void {
    if (!additive) this.selection = new Set(ids);
    else if (ids.length === 1) { const id = ids[0]!; if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id); }
    else ids.forEach((id) => this.selection.add(id));
    this.detail = null; const version = ++this.detailVersion;
    this.renderSelection(); this.renderInspector();
    if (this.selection.size === 1 && this.status) {
      const id = [...this.selection][0]!, scanId = this.status.scanId;
      void this.backend.details(scanId, id).then((detail) => {
        if (version !== this.detailVersion || this.status?.scanId !== scanId) return;
        this.detail = detail; this.renderInspector();
      }).catch((error: unknown) => { if (version === this.detailVersion) this.notify(errorMessage(error), true); });
    }
  }
  private renderSelection(): void {
    for (const surface of ['file-list', 'treemap']) el(surface).querySelectorAll<HTMLElement>('[data-file-id]').forEach(row => {
      const id = Number(row.dataset.fileId), selected = this.selection.has(id);
      row.classList.toggle('selected', selected); row.classList.toggle('planned', this.planned.has(id));
      const input = row.querySelector<HTMLInputElement>('input'); if (input) input.checked = selected;
    });
  }
  private renderInspector(): void {
    show('inspector', this.selection.size > 0); if (!this.selection.size) return;
    const close = ui`<button class="icon-button inspector-close" data-action="close" aria-label="Снять выделение">×</button>`;
    const disabled = this.mutation || busy(this.status?.phase) ? 'disabled' : '';
    if (this.selection.size > 1) {
      el('inspector').innerHTML = ui`${close}<h2>${number(this.selection.size)} ${fileWord(this.selection.size)}</h2><div class="inspector-actions"><button class="danger-secondary" data-action="trash" ${disabled}>${icon('trash')}В Корзину…</button></div>`; return;
    }
    const detail = this.detail;
    if (!detail) { el('inspector').innerHTML = ui`${close}<p class="muted">Загрузка сведений…</p>`; return; }
    const file = detail.file;
    el('inspector').innerHTML = ui`${close}<h2>${esc(file.name)}</h2><div class="file-size">${formatBytes(file.allocatedBytes ?? file.logicalBytes)}<small>На диске${file.allocatedBytes === null ? ' ≈' : ''}</small></div><p class="file-path" title="${esc(detail.path)}">${esc(detail.path)}</p>${file.hardLink ? '<p class="muted">' + ui('Жёсткая ссылка') + '</p>' : ''}${!file.actionable ? '<p class="muted">' + ui('Нет надёжной идентификации') + '</p>' : ''}<div class="inspector-actions"><button class="secondary" data-action="open" ${disabled}>${icon('open')}Открыть</button><button class="secondary" data-action="reveal" ${disabled}>${icon('folder')}${revealLabel('file')}</button><button class="danger-secondary" data-action="trash" ${disabled || !file.actionable ? 'disabled' : ''}>${icon('trash')}В Корзину…</button></div>`;
  }
  private async openFile(id: number): Promise<void> {
    await this.act(async (scanId) => {
      const detail = await this.backend.details(scanId, id);
      if (detail.file.executable && !(await this.message.ask(ui('Открыть исполняемый файл?'), ui`${detail.file.name}\n\nСистема может запустить программу или установщик. Открывайте только файлы, которым доверяете.`, ui('Открыть'), true))) return;
      await this.backend.open(scanId, id, detail.file.executable);
    });
  }
  private async addToPlan(ids: number[]): Promise<void> {
    if (!ids.length || this.mutation || busy(this.status?.phase)) return;
    let added = false;
    await this.act(async scanId => {
      await this.backend.planAdd(scanId, ids); ids.forEach(id => this.planned.add(id)); added = true;
    });
    if (added) await this.openReview();
  }
  private async openReview(): Promise<void> {
    if (!this.status || busy(this.status.phase) || this.mutation) return;
    try {
      await this.loadReview(0);
      if (this.reviewPage?.count) { el<HTMLDialogElement>('review').showModal(); el('review-cancel').focus(); }
    } catch (error) { this.notify(errorMessage(error), true); }
  }
  private async loadReview(offset: number): Promise<void> {
    if (!this.status || this.reviewLoading) return;
    this.reviewLoading = true; disable('review-confirm', true);
    try { this.reviewPage = await this.backend.planPage(this.status.scanId, offset); this.renderReview(); }
    catch (error) { this.reviewPage = null; this.notify(errorMessage(error), true); }
    finally { this.reviewLoading = false; disable('review-confirm', !this.reviewPage?.count || this.mutation); }
  }
  private renderReview(): void {
    const page = this.reviewPage; if (!page) return;
    el('review-summary').innerHTML = ui`<strong>${number(page.count)} ${fileWord(page.count)}</strong><span>${formatBytes(page.logicalBytes)} содержимого</span>`;
    el('review-files').innerHTML = page.files.length ? page.files.map((file) => ui`<div class="review-row"><span class="color-dot" style="background:${colors[file.category]}"></span><div><strong>${esc(file.name)}</strong><small>${esc(file.relativePath)}</small></div><span>${formatBytes(file.logicalBytes)}</span><button class="icon-button" data-remove="${file.id}" title="Убрать из списка" aria-label="Убрать ${esc(file.name)} из списка">×</button></div>`).join('') : ui('<p class="muted" style="padding:25px 0">Список пуст. Файлы остаются на месте.</p>');
    el('review-pagination').innerHTML = this.pagination(page.offset, page.count, 'review-page');
    text('review-confirm', ui('Переместить в Корзину')); disable('review-confirm', !page.count || this.mutation);
  }
  private async removeFromReview(id: number): Promise<void> {
    await this.act(async (scanId) => { await this.backend.planRemove(scanId, [id]); this.planned.delete(id); await this.loadReview(this.reviewPage?.offset ?? 0); });
  }
  private async execute(): Promise<void> {
    if (!this.status || !this.reviewPage?.count || this.mutation || this.reviewLoading) return;
    await this.act(async (id) => {
      disable('review-confirm', true);
      await this.backend.executePlan(id, this.reviewPage!.revision);
      el<HTMLDialogElement>('review').close(); this.reviewPage = null;
    });
    disable('review-confirm', !this.reviewPage?.count);
  }
  private async act(work: (scanId: number) => Promise<unknown>, allowBusy = false): Promise<void> {
    if (!this.status || this.mutation || (!allowBusy && busy(this.status.phase))) return;
    this.mutation = true; this.renderStatus(); const id = this.status.scanId;
    try { await work(id); await this.refreshStatus(); }
    catch (error) { this.notify(errorMessage(error), true); }
    finally { this.mutation = false; this.renderStatus(); if (this.reviewPage) this.renderReview(); }
  }
  private notify(message: string, error = false): void {
    clearTimeout(this.toastTimer); text('toast-message', message); el('toast').classList.toggle('error', error); show('toast', true);
    this.toastTimer = setTimeout(() => show('toast', false), error ? 12_000 : 6500);
  }
  private async showIssues(): Promise<void> {
    if (!this.status) return;
    const s = this.status;
    const lines = [ui`Пропущено ссылок и облачных объектов: ${s.skippedLinks}`, ui`Пропущено специальных объектов и служебных каталогов: ${s.skippedSpecial}`, ui`Ошибок сканирования и проверки: ${s.issuesCount}`, ui`Ошибок переноса в Корзину: ${s.operation.failed}`, '', ...s.issues.concat(s.operation.errors).map((issue) => `${issue.path}\n${errorMessage(issue.message)}`)];
    if (s.issuesCount > s.issues.length || s.operation.failed > s.operation.errors.length) lines.push(ui('\nПоказаны первые 100 ошибок каждого вида.'));
    await this.message.info(ui('Отчёт об обработке'), lines.join('\n'));
  }
  private async syncLanguage(): Promise<void> {
    if (!this.backend.demo && window.__TAURI__) await window.__TAURI__.core.invoke('set_language', { language: locale() });
  }
  private async syncPlan(scanId: number): Promise<void> {
    const planned = new Set<number>();
    for (let offset = 0; ; offset += 200) {
      const page = await this.backend.planPage(scanId, offset);
      page.files.forEach(file => planned.add(file.id));
      if (offset + 200 >= page.count) break;
    }
    if (this.status?.scanId === scanId) this.planned = planned;
  }
  private async changeLanguage(): Promise<void> {
    setLocale(locale() === 'ru' ? 'en' : 'ru');
    this.renderFilters(); this.renderStatus(); this.renderList(); this.renderInspector(); this.renderSelection(); this.renderEmpty();
    if (this.reviewPage) this.renderReview();
    this.renderMap();
    show('toast', false);
    try { await this.syncLanguage(); } catch (error) { this.notify(errorMessage(error), true); }
  }
  private keydown(event: KeyboardEvent): void {
    if (document.querySelector('dialog[open]')) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); el('search').focus(); }
    if (modifier && event.key.toLowerCase() === 'o') { event.preventDefault(); void this.choose(false); }
    if (event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') return;
    if (event.key === 'Escape') { if (this.contextTarget) this.hideContextMenu(); else this.select([], false); }
    if (event.key === 'Delete' || (event.metaKey && event.key === 'Backspace')) { event.preventDefault(); void this.addToPlan([...this.selection]); }
    if (event.altKey && event.key === 'ArrowUp' && this.view && this.view.breadcrumbs.length > 1) { event.preventDefault(); this.enterDirectory(this.view.breadcrumbs.at(-2)!.id); }
    if (modifier && event.key.toLowerCase() === 'a' && this.view) { event.preventDefault(); this.select(this.view.files.map(file => file.id), false); }
    if (event.key === 'Enter' && this.selection.size === 1 && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void this.openFile([...this.selection][0]!); }
  }
}

const folderColors = ['#bac8e8', '#abcac2', '#c6bade', '#adc9dc', '#ddc6aa', '#c7d0a8'];
const fileColor = (category: keyof typeof colors): string => ({ video: '#bac8e8', image: '#abcac2', audio: '#c6bade', document: '#adc9dc', archive: '#ddc6aa', code: '#c7d0a8', executable: '#dfbbc1', other: '#c5c8d1' })[category];
