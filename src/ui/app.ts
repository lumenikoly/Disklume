import type { Backend, Category, FileDetail, Filter, MapNode, PlanPage, Status, View } from '../types.js';
import { busy, defaultFilter } from '../types.js';
import { basename, categories, categoryLabel, colors, date, errorMessage, escapeHtml as esc, fileWord, formatBytes, number } from '../format.js';
import { initLocale, intlLocale, locale, setLocale, ui } from '../i18n.js';
import { FileMap } from '../map/renderer.js';
import { el, disable, on, show, text } from './dom.js';
import { icon } from './icons.js';
import { MessageDialog } from './dialog.js';

export class App {
  private status: Status | null = null;
  private view: View | null = null;
  private filter = defaultFilter();
  private selection = new Set<number>();
  private planned = new Set<number>();
  private detail: FileDetail | null = null;
  private map: FileMap | null = null;
  private mode: 'map' | 'list' = 'map';
  private offset = 0;
  private history: { filter: Filter; label: string }[] = [];
  private message = new MessageDialog();
  private timer: ReturnType<typeof setInterval> | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private mutation = false;
  private queryVersion = 0;
  private queryRunning = false;
  private detailVersion = 0;
  private fitNext = true;
  private reviewPage: PlanPage | null = null;
  private reviewLoading = false;
  private events = new AbortController();
  constructor(private backend: Backend) {
    try { const metric = localStorage.getItem('clearmap.metric'); if (metric === 'logical' || metric === 'allocated') this.filter.metric = metric; } catch { /* Settings are optional. */ }
    initLocale();
    this.bind();
    this.renderCategories();
  }
  async start(): Promise<void> {
    await this.syncLanguage();
    if (this.backend.demo) { await this.activate(await this.backend.chooseFolder()); }
    else {
      const current = await this.backend.currentStatus();
      if (current) await this.activate(current.scanId);
    }
    this.timer = setInterval(() => {
      if (this.status && busy(this.status.phase) && !this.polling) void this.refreshStatus().catch((e: unknown) => this.notify(errorMessage(e), true));
    }, 500);
  }
  destroy(): void {
    this.events.abort(); this.map?.destroy(); clearInterval(this.timer); clearTimeout(this.searchTimer); clearTimeout(this.toastTimer);
  }
  private bind(): void {
    on('choose-folder', () => void this.choose(false)); on('welcome-choose', () => void this.choose(false));
    on('rescan', () => void this.choose(true));
    on('brand', () => { if (this.view) this.map?.fit(); });
    on('help', () => void this.help()); on('language', () => void this.changeLanguage());
    on('filter-large', () => this.changeFilter({ minBytes: this.filter.minBytes ? 0 : 1024 ** 3 }));
    on('filter-old', () => this.changeFilter({ olderDays: this.filter.olderDays ? null : 365 }));
    on('filter-duplicates', () => this.changeFilter({ duplicatesOnly: !this.filter.duplicatesOnly }));
    on('filter-screenshots', () => this.changeFilter({ screenshotsOnly: !this.filter.screenshotsOnly }));
    on('clear-filters', () => { const { metric, folders, directoryId } = this.filter; this.filter = { ...defaultFilter(), metric, folders, directoryId }; el<HTMLInputElement>('search').value = ''; this.changeFilter({}); });
    on('find-duplicates', () => void this.act(async (id) => { await this.backend.findDuplicates(id); }));
    on('cancel-job', () => void this.act(async (id) => { await this.backend.cancel(id); }, true));
    on('mode-map', () => this.setMode('map')); on('mode-list', () => this.setMode('list'));
    on('browse-files', () => this.setBrowse(false)); on('browse-folders', () => this.setBrowse(true));
    on('zoom-in', () => this.map?.zoom(1.4)); on('zoom-out', () => this.map?.zoom(1 / 1.4)); on('fit', () => this.map?.fit());
    on('dropzone', () => void this.addToPlan([...this.selection]));
    on('review-open', () => void this.openReview());
    for (const id of ['review-close', 'review-cancel']) on(id, () => { if (!this.mutation) el<HTMLDialogElement>('review').close(); });
    el<HTMLDialogElement>('review').addEventListener('cancel', (event) => { if (this.mutation) event.preventDefault(); });
    on('review-confirm', () => void this.execute());
    on('plan-clear', () => void this.act(async (id) => { await this.backend.planClear(id); this.planned.clear(); }));
    on('show-issues', () => void this.showIssues());
    on('toast-close', () => show('toast', false));
    el<HTMLInputElement>('search').addEventListener('input', () => {
      clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.changeFilter({ text: el<HTMLInputElement>('search').value.trim() }), 200);
    });
    el<HTMLSelectElement>('metric').addEventListener('change', () => {
      const metric = el<HTMLSelectElement>('metric').value === 'logical' ? 'logical' : 'allocated';
      try { localStorage.setItem('clearmap.metric', metric); } catch { /* Optional. */ }
      this.changeFilter({ metric }); this.renderStatus();
    });
    document.addEventListener('keydown', (event) => this.keydown(event), { signal: this.events.signal });
    el('categories').addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-category]');
      if (button) this.changeFilter({ category: (button.dataset.category || null) as Category | null });
    });
    el('file-list').addEventListener('click', (event) => {
      const target = event.target as Element;
      const page = target.closest<HTMLButtonElement>('[data-page]');
      if (page) { this.offset = Number(page.dataset.page); this.select([], false); void this.loadView(); return; }
      const directory = target.closest<HTMLButtonElement>('[data-directory]');
      if (directory) { this.enterDirectory(Number(directory.dataset.directory)); return; }
      const row = target.closest<HTMLElement>('[data-file-id]');
      if (row) this.select([Number(row.dataset.fileId)], target instanceof HTMLInputElement || event.ctrlKey || event.metaKey);
    });
    el('file-list').addEventListener('dblclick', (event) => {
      const row = (event.target as Element).closest<HTMLElement>('[data-file-id]');
      if (row && !(event.target instanceof HTMLInputElement)) void this.openFile(Number(row.dataset.fileId));
    });
    el('inspector').addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
      const id = button.dataset.fileId ? Number(button.dataset.fileId) : this.detail?.file.id;
      if (button.dataset.action === 'close') this.select([], false);
      if (button.dataset.action === 'open' && id !== undefined) void this.openFile(id);
      if (button.dataset.action === 'reveal' && id !== undefined) void this.act(async (scanId) => this.backend.reveal(scanId, id));
      if (button.dataset.action === 'trash') void this.addToPlan([...this.selection]);
      if (button.dataset.action === 'select' && id !== undefined) this.select([id], false);
      if (button.dataset.action === 'group' && this.detail?.file.duplicateGroup !== null) this.changeFilter({ duplicateGroup: this.detail?.file.duplicateGroup ?? null, duplicatesOnly: true });
    });
    el('review-files').addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-remove]');
      if (button) void this.removeFromReview(Number(button.dataset.remove));
    });
    el('review-pagination').addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-review-page]');
      if (button) void this.loadReview(Number(button.dataset.reviewPage));
    });
    el('breadcrumbs').addEventListener('click', (event) => {
      const directory = (event.target as Element).closest<HTMLButtonElement>('[data-directory]');
      if (directory) { this.enterDirectory(Number(directory.dataset.directory)); return; }
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-crumb]');
      if (!button) return;
      const index = Number(button.dataset.crumb), entry = this.history[index];
      if (entry) { this.filter = structuredClone(entry.filter); this.history = this.history.slice(0, index); this.offset = 0; this.fitNext = true; this.select([], false); this.renderFilters(); void this.loadView(); }
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
    this.filter = { ...defaultFilter(), metric: this.filter.metric, folders: this.filter.folders }; this.history = []; this.offset = 0;
    this.planned.clear(); this.selection.clear(); this.detail = null; this.detailVersion++; this.fitNext = true;
    el<HTMLInputElement>('search').value = '';
    show('welcome', false); show('workspace', true);
    this.renderStatus();
    if (!this.map) {
      try { this.map = new FileMap(el<HTMLCanvasElement>('map'), {
        select: (ids, additive) => this.select(ids, additive), drill: (node) => this.drill(node),
        drag: (active, x, y) => this.drag(active, x, y),
        drop: (ids, x, y) => { if (this.overDropzone(x, y)) void this.addToPlan(ids); },
        error: (error) => { this.setMode('list'); this.notify(errorMessage(error), true); },
      }); } catch (error) { this.setMode('list'); this.notify(errorMessage(error), true); }
    }
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
        this.view = view; this.offset = view.offset; this.map?.setData(view.nodes, this.fitNext); this.fitNext = false;
        this.renderList(); this.renderFilters(); this.renderEmpty(); this.renderSelection();
      }
    } catch (error) { this.notify(errorMessage(error), true); }
    finally { this.queryRunning = false; }
  }
  private changeFilter(change: Partial<Filter>): void {
    this.filter = { ...this.filter, ...change, bucket: null }; this.history = []; this.offset = 0; this.fitNext = true;
    this.select([], false); this.renderFilters(); void this.loadView();
  }
  private drill(node: MapNode): void {
    if (!node.bucket) return;
    this.history.push({ filter: structuredClone(this.filter), label: categoryLabel(node.category) });
    this.filter.bucket = node.bucket; this.offset = 0; this.fitNext = true;
    this.select([], false); this.renderFilters(); void this.loadView();
  }
  private renderCategories(): void {
    el('categories').innerHTML = `<button class="category ${this.filter.category === null ? 'active' : ''}" data-category="">${ui('Все файлы')}</button>${categories.map((c) => `<button class="category ${this.filter.category === c ? 'active' : ''}" data-category="${c}"><span class="color-dot" style="background:${colors[c]}"></span>${categoryLabel(c)}</button>`).join('')}`;
  }
  private renderFilters(): void {
    this.renderCategories();
    for (const [id, active] of [['filter-large', this.filter.minBytes > 0], ['filter-old', this.filter.olderDays !== null], ['filter-duplicates', this.filter.duplicatesOnly], ['filter-screenshots', this.filter.screenshotsOnly]] as const) {
      el(id).classList.toggle('active', active); el(id).setAttribute('aria-pressed', String(active));
    }
    show('clear-filters', Boolean(this.filter.text || this.filter.category || this.filter.minBytes || this.filter.olderDays || this.filter.duplicatesOnly || this.filter.screenshotsOnly || this.filter.duplicateGroup !== null));
    el<HTMLSelectElement>('metric').value = this.filter.metric;
    const crumbs = this.history.length ? ui`<button data-crumb="0">Карта</button>${this.history.slice(0, -1).map((h, i) => `<span>›</span><button data-crumb="${i + 1}">${esc(h.label)}</button>`).join('')}<span>›</span><span class="current">${esc(this.history.at(-1)!.label)}</span>` : ui('<span class="map-label">Карта файлов</span>');
    el('breadcrumbs').innerHTML = crumbs;
    if (this.filter.folders && this.view) {
      const path = this.view.breadcrumbs;
      el('breadcrumbs').innerHTML = `${path.length > 1 ? `<button data-directory="${path.at(-2)!.id}" aria-label="${ui('На уровень выше')}">↑</button>` : ''}${path.map((entry, i) => `${i ? '<span>›</span>' : ''}${i === path.length - 1 ? `<span class="current" title="${esc(entry.name)}">${esc(entry.name)}</span>` : `<button data-directory="${entry.id}" title="${esc(entry.name)}">${esc(entry.name)}</button>`}`).join('')}`;
      el('breadcrumbs').scrollLeft = el('breadcrumbs').scrollWidth;
    }
    show('breadcrumbs', this.filter.folders || this.history.length > 0);
    for (const [id, active] of [['browse-files', !this.filter.folders], ['browse-folders', this.filter.folders]] as const) {
      el(id).classList.toggle('active', active); el(id).setAttribute('aria-pressed', String(active));
    }
    this.renderViewMode();
    text('view-count', this.view ? `${number(this.view.total)} ${fileWord(this.view.total)} · ${formatBytes(this.view.bytes)}` : '');
  }
  private renderStatus(): void {
    const status = this.status, working = busy(status?.phase), locked = working || this.mutation;
    disable('choose-folder', locked); disable('welcome-choose', this.mutation); disable('rescan', !status || locked);
    disable('find-duplicates', !status || locked); disable('plan-clear', locked); disable('dropzone', !this.selection.size || locked);
    disable('review-open', locked); disable('cancel-job', this.mutation);
    if (!status) return;
    text('folder-name', basename(status.root)); text('title', basename(status.root)); text('folder-path', status.root);
    el('folder-path').title = status.root;
    text('total-size', formatBytes(this.filter.metric === 'allocated' ? status.allocatedBytes : status.logicalBytes));
    text('total-count', number(status.files));
    show('subtitle', false);
    text('duplicate-badge', number(status.duplicateFiles)); show('duplicate-badge', status.duplicateFiles > 0);
    show('cancel-job', working); el('status-indicator').classList.toggle('working', working);
    let line = '';
    if (status.phase === 'scanning') line = ui`Сканирование · ${number(status.files)} ${fileWord(status.files)}${status.currentPath ? ` · ${status.currentPath}` : ''}`;
    else if (status.phase === 'hashing') line = ui`Поиск совпадений · ${number(status.hashFiles)} / ${number(status.hashCandidates)} кандидатов · прочитано ${formatBytes(status.hashBytes)}`;
    else if (status.phase === 'deleting') line = ui`В Корзину · ${status.operation.completed} / ${status.operation.total} · выполнено ${status.operation.succeeded}`;
    else if (status.phase === 'cancelled') line = ui('Остановлено · результаты могут быть неполными');
    else if (status.phase === 'failed') line = ui('Операция не завершена · откройте отчёт');
    else line = ui`Готово · ${(status.elapsedMs / 1000).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })} с · ${number(status.skippedLinks)} ссылок пропущено${status.approximateCount ? ui(' · часть размеров приблизительна') : ''}`;
    text('status-text', line); el('status-text').title = line;
    const issueCount = status.issuesCount + status.operation.failed;
    text('show-issues', ui`Отчёт${issueCount ? `: ${issueCount}` : ''}`); show('show-issues', issueCount > 0 || status.skippedLinks > 0 || status.skippedSpecial > 0);
    show('plan-empty', !status.planCount); show('plan-summary', status.planCount > 0); show('review-open', status.planCount > 0);
    show('actionbar', Boolean(status.planCount || this.selection.size));
    text('plan-size', formatBytes(status.planBytes)); text('plan-count', ui`${number(status.planCount)} ${fileWord(status.planCount)} в списке удаления`);
    this.map?.setSelection(this.selection, this.planned);
    el('inspector').querySelectorAll<HTMLButtonElement>('[data-action="trash"], [data-action="open"], [data-action="reveal"]').forEach((button) => { button.disabled = locked || (button.dataset.action === 'trash' && this.selection.size === 1 && this.detail?.file.actionable === false); });
    el('file-list').querySelectorAll<HTMLElement>('[data-file-id]').forEach(row => row.classList.toggle('planned', this.planned.has(Number(row.dataset.fileId))));
  }
  private renderEmpty(): void {
    const empty = this.filter.folders ? this.view?.entryTotal === 0 : this.view?.total === 0; show('empty-state', empty);
    text('empty-message', this.status?.phase === 'scanning' ? ui('Сканирование продолжается…') : this.filter.duplicatesOnly && this.status?.duplicateGroups === 0 ? ui('Запустите проверку совпадений или измените фильтры.') : this.status?.files === 0 ? ui('В этой папке не найдено обычных файлов.') : ui('Попробуйте изменить фильтры.'));
    if (empty && this.filter.folders && !busy(this.status?.phase) && !this.filter.text && !this.filter.category && !this.filter.minBytes && this.filter.olderDays === null && !this.filter.duplicatesOnly && !this.filter.screenshotsOnly && this.filter.duplicateGroup === null) text('empty-message', ui('Папка пуста.'));
  }
  private setMode(mode: 'map' | 'list'): void {
    this.mode = mode; this.renderViewMode();
    el('mode-map').classList.toggle('active', mode === 'map'); el('mode-list').classList.toggle('active', mode === 'list');
    el('mode-map').setAttribute('aria-pressed', String(mode === 'map')); el('mode-list').setAttribute('aria-pressed', String(mode === 'list'));
    this.select([], false); if (mode === 'map') this.map?.fit(); else this.renderList();
  }
  private renderViewMode(): void {
    const map = !this.filter.folders && this.mode === 'map';
    show('map-region', map); show('file-list', !map); show('file-view-switch', !this.filter.folders);
    show('scale-note', map);
  }
  private setBrowse(folders: boolean): void {
    if (this.filter.folders === folders) return;
    this.changeFilter({ folders, directoryId: null });
  }
  private enterDirectory(directoryId: number): void {
    this.changeFilter({ directoryId });
    el('file-list').scrollTop = 0;
  }
  private renderList(): void {
    if (!this.view) return;
    const view = this.view;
    el('file-list').classList.toggle('folder-list', this.filter.folders);
    if (this.filter.folders) {
      el('file-list').innerHTML = ui`<table><thead><tr><th></th><th>Имя</th><th>Размер</th><th>Доля</th><th>Файлов</th></tr></thead><tbody>${view.entries.map(entry => {
        const file = entry.file, share = view.bytes ? entry.bytes / view.bytes * 100 : 0;
        return `<tr ${file ? `data-file-id="${file.id}"` : ''} class="${file && this.selection.has(file.id) ? 'selected' : ''} ${file && this.planned.has(file.id) ? 'planned' : ''}"><td>${file ? `<input type="checkbox" aria-label="${ui('Выбрать')} ${esc(file.name)}" ${this.selection.has(file.id) ? 'checked' : ''}>` : icon('folder')}</td><td>${entry.directoryId !== null ? `<button class="directory-link" data-directory="${entry.directoryId}" title="${esc(entry.name)}"><strong>${esc(entry.name)}</strong><span>›</span></button>` : `<div class="file-name-cell" title="${esc(entry.name)}"><span class="color-dot" style="background:${colors[file!.category]}"></span><strong>${esc(entry.name)}</strong></div>`}</td><td class="size-cell">${formatBytes(entry.bytes)}</td><td><div class="size-share"><span class="size-bar" style="width:${Math.min(100, share)}%"></span><span>${share.toLocaleString(intlLocale(), { maximumFractionDigits: 1 })}%</span></div></td><td>${number(entry.count)}</td></tr>`;
      }).join('')}</tbody></table>${this.pagination(view.offset, view.entryTotal, 'page')}`;
      return;
    }
    el('file-list').innerHTML = ui`<table><thead><tr><th></th><th>Файл</th><th>Тип</th><th>${this.filter.metric === 'allocated' ? ui('На диске') : ui('Размер')}</th><th>Изменён</th></tr></thead><tbody>${view.files.map((file) => ui`<tr data-file-id="${file.id}" class="${this.selection.has(file.id) ? 'selected' : ''} ${this.planned.has(file.id) ? 'planned' : ''}"><td><input type="checkbox" aria-label="Выбрать ${esc(file.name)}" ${this.selection.has(file.id) ? 'checked' : ''}></td><td><div class="file-name-cell"><span class="color-dot" style="background:${colors[file.category]}"></span><div><strong>${esc(file.name)}</strong><small>${esc(file.relativePath)}</small></div></div></td><td>${categoryLabel(file.category)}${file.duplicateGroup !== null ? ui(' <span class="badge">Копия</span>') : ''}</td><td>${formatBytes(this.filter.metric === 'allocated' ? file.chargedBytes : file.logicalBytes)}</td><td>${file.modifiedMs === null ? '—' : new Date(file.modifiedMs).toLocaleDateString(intlLocale())}</td></tr>`).join('')}</tbody></table>${this.pagination(view.offset, view.total, 'page')}`;
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
    show('actionbar', Boolean(this.selection.size || this.status?.planCount));
    this.map?.setSelection(this.selection, this.planned);
    el('file-list').querySelectorAll<HTMLElement>('[data-file-id]').forEach((row) => {
      const selected = this.selection.has(Number(row.dataset.fileId)); row.classList.toggle('selected', selected);
      const input = row.querySelector<HTMLInputElement>('input'); if (input) input.checked = selected;
    });
    text('selection-info', this.selection.size ? `${locale() === 'ru' ? ui('Выбрано') : 'Selected'}: ${number(this.selection.size)} ${fileWord(this.selection.size)} · Esc — ${locale() === 'ru' ? ui('снять выделение') : 'clear selection'}` : this.filter.folders ? ui('Нажмите папку, чтобы открыть её содержимое') : this.mode === 'list' ? ui('Выберите файл') : ui('Выберите круг, чтобы увидеть файл'));
    text('dropzone-text', this.selection.size ? `${ui('В список удаления')} · ${number(this.selection.size)}` : ui('В список удаления'));
    show('actionbar', Boolean(this.selection.size || this.status?.planCount));
    disable('dropzone', !this.selection.size || this.mutation || busy(this.status?.phase));
  }
  private renderInspector(): void {
    show('inspector', this.selection.size > 0); if (!this.selection.size) return;
    const close = ui`<div class="inspector-top"><span class="eyebrow">${this.selection.size === 1 ? ui('ВЫБРАННЫЙ ФАЙЛ') : ui('ВЫБРАННЫЕ ФАЙЛЫ')}</span><button class="icon-button" data-action="close" aria-label="Снять выделение">×</button></div>`;
    const disabled = this.mutation || busy(this.status?.phase) ? 'disabled' : '';
    if (this.selection.size > 1) {
      el('inspector').innerHTML = ui`${close}<h2>${number(this.selection.size)} ${fileWord(this.selection.size)}</h2><p class="selection-info-note">В список удаления попадут только выделенные файлы. Перед переносом в Корзину вы сможете проверить каждый из них.</p><div class="inspector-actions"><button class="danger-secondary" data-action="trash" ${disabled}>${icon('trash')}В список удаления</button></div>`; return;
    }
    const detail = this.detail;
    if (!detail) { el('inspector').innerHTML = ui`${close}<p class="muted">Загрузка сведений…</p>`; return; }
    const file = detail.file;
    const flags = [file.screenshot ? ui('Возможно, скриншот') : '', file.hardLink ? ui('Жёсткая ссылка') : '', file.allocatedBytes === null ? ui('Размер на диске приблизителен') : '', !file.actionable ? ui('Нет надёжной идентификации') : ''].filter(Boolean);
    el('inspector').innerHTML = ui`${close}<div class="file-icon" style="background:${colors[file.category]}22;color:${colors[file.category]}">${icon(file.category === 'video' ? 'video' : file.category === 'image' ? 'image' : 'file')}</div><h2 style="margin-top:14px">${esc(file.name)}</h2><div class="file-size">${formatBytes(file.logicalBytes)}</div><div class="file-flags">${flags.map((flag) => `<span class="badge">${flag}</span>`).join('')}</div><div class="file-meta"><div class="meta-row"><span>Тип</span><span>${categoryLabel(file.category)}</span></div><div class="meta-row"><span>На диске</span><span>${file.allocatedBytes === null ? '≈ ' : ''}${formatBytes(file.allocatedBytes ?? file.logicalBytes)}</span></div><div class="meta-row"><span>Вклад в карту</span><span>${formatBytes(this.filter.metric === 'allocated' ? file.chargedBytes : file.logicalBytes)}</span></div><div class="meta-row"><span>Изменён</span><span>${date(file.modifiedMs)}</span></div></div><p class="file-path">${esc(detail.path)}</p><div class="inspector-actions"><button class="secondary" data-action="open" ${disabled}>${icon('open')}Открыть</button><button class="secondary" data-action="reveal" ${disabled}>${icon('folder')}Показать в папке</button><button class="danger-secondary" data-action="trash" ${disabled || !file.actionable ? 'disabled' : ''}>${icon('trash')}В список удаления</button></div>${detail.duplicateCount ? ui`<div class="duplicate-info">Найдены точные копии: ${detail.duplicateCount}${detail.duplicates.map((copy) => `<button data-action="select" data-file-id="${copy.id}">${esc(copy.relativePath)}</button>`).join('')}<button data-action="group">Показать группу на карте</button><small>Совпадение полных хешей на момент проверки. Ни одна копия не удаляется автоматически.</small></div>` : ''}`;
  }
  private async openFile(id: number): Promise<void> {
    await this.act(async (scanId) => {
      const detail = await this.backend.details(scanId, id);
      if (detail.file.executable && !(await this.message.ask(ui('Открыть исполняемый файл?'), ui`${detail.file.name}\n\nСистема может запустить программу или установщик. Открывайте только файлы, которым доверяете.`, ui('Открыть'), true))) return;
      await this.backend.open(scanId, id, detail.file.executable);
    });
  }
  private async addToPlan(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.act(async (scanId) => {
      await this.backend.planAdd(scanId, ids); ids.forEach((id) => this.planned.add(id)); this.select([], false);
      this.notify(ui`Добавлено в список: ${number(ids.length)} ${fileWord(ids.length)}. Файлы пока на месте.`);
    });
  }
  private overDropzone(x: number, y: number): boolean { const r = el('dropzone').getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
  private drag(active: boolean, x: number, y: number): void {
    const allowed = active && !busy(this.status?.phase) && !this.mutation;
    el('dropzone').classList.toggle('drag-active', allowed); el('dropzone').classList.toggle('drop-hover', allowed && this.overDropzone(x, y));
    show('drag-label', allowed);
    if (allowed) { text('drag-label', `${this.selection.size} ${fileWord(this.selection.size)}`); el('drag-label').style.left = `${x + 15}px`; el('drag-label').style.top = `${y + 12}px`; }
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
  private async help(): Promise<void> {
    await this.message.info(ui('Как читать карту'), ui('Площадь круга — размер файла, цвет — тип. Пунктир — группа: нажмите, чтобы раскрыть. В режиме «Папки» размеры включают вложенные файлы. Нажмите папку для перехода внутрь, путь сверху — для возврата.') + '\n\n' + ui('Колесо — масштаб. Фон — перемещение. Ctrl / ⌘ + щелчок — несколько файлов. Shift + движение — рамка. Delete — добавить в список удаления.') + '\n\n' + ui('Перенос в Корзину обычно не освобождает место. Размер на диске — оценка. Скриншоты определяются по имени. После внешних изменений обновите папку.'));
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
    this.history = this.history.map(entry => ({ ...entry, label: entry.filter.bucket ? categoryLabel(entry.filter.bucket.category) : ui('Карта') }));
    this.renderFilters(); this.renderStatus(); this.renderList(); this.renderInspector(); this.renderSelection(); this.renderEmpty();
    if (this.reviewPage) this.renderReview();
    if (this.view) this.map?.setData(this.view.nodes, false);
    show('toast', false);
    try { await this.syncLanguage(); } catch (error) { this.notify(errorMessage(error), true); }
  }
  private keydown(event: KeyboardEvent): void {
    if (document.querySelector('dialog[open]')) return;
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); el<HTMLInputElement>('search').focus(); return; }
    if (modifier && event.key.toLowerCase() === 'o') { event.preventDefault(); void this.choose(false); return; }
    if (typing) return;
    if (event.key === 'Escape') this.select([], false);
    if (event.key === 'Delete' || (event.metaKey && event.key === 'Backspace')) { event.preventDefault(); void this.addToPlan([...this.selection]); }
    if (event.altKey && event.key === 'ArrowUp' && this.filter.folders && this.view?.breadcrumbs.length && this.view.breadcrumbs.length > 1) { event.preventDefault(); this.enterDirectory(this.view.breadcrumbs.at(-2)!.id); }
    if (modifier && event.key.toLowerCase() === 'a' && this.view) { event.preventDefault(); this.select(!this.filter.folders && this.mode === 'map' ? this.map?.visibleIds() ?? [] : this.view.files.map((f) => f.id), false); }
    if (event.key === 'Enter' && this.selection.size === 1 && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void this.openFile([...this.selection][0]!); }
  }
}
