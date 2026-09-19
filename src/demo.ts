/** Explicitly synthetic adapter. It never calls native APIs or touches user files. */
import type { Backend, Bucket, Category, FileDetail, FileSummary, Filter, MapNode, PlanPage, Status, View } from './types.js';
import { busy } from './types.js';
import { categories } from './format.js';
const GiB = 1024 ** 3, MiB = 1024 ** 2;
export class DemoBackend implements Backend {
  readonly demo = true;
  private files: FileSummary[] = [];
  private scanId = 0;
  private revision = 0;
  private phase: Status['phase'] = 'ready';
  private plan = new Set<number>();
  private planRevision = 0;
  private operation: Status['operation'] = { total: 0, completed: 0, succeeded: 0, failed: 0, errors: [] };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private duplicatesFound = false;
  private directories = new Map<number, { id: number; name: string; path: string; parent: number | null }>();
  private directoryIds = new Map<string, number>();
  private makeFiles(): FileSummary[] {
    const now = Date.now();
    const rows: FileSummary[] = [];
    const add = (name: string, category: Category, bytes: number, days: number, folder = '') => {
      const id = rows.length;
      rows.push({ id, name, relativePath: folder ? `${folder}/${name}` : name, category, logicalBytes: Math.round(bytes), allocatedBytes: Math.ceil(bytes / 4096) * 4096,
        chargedBytes: Math.ceil(bytes / 4096) * 4096, modifiedMs: now - days * 86_400_000, ageBucket: days < 7 ? 0 : days < 30 ? 1 : days < 90 ? 2 : days < 365 ? 3 : 4,
        screenshot: name.startsWith('Снимок экрана'), hardLink: false, executable: category === 'executable', duplicateGroup: null, actionable: true });
    };
    add('Летнее путешествие.mov', 'video', 14.6 * GiB, 430, 'Видео');
    add('Летнее путешествие — копия.mov', 'video', 14.6 * GiB, 430, 'Видео/Копии');
    add('Запись экрана 2025.mp4', 'video', 5.8 * GiB, 190);
    add('Интервью — исходник.mkv', 'video', 2.2 * GiB, 53);
    add('Резервная копия 2024.zip', 'archive', 8.2 * GiB, 570, 'Архивы');
    add('Старый образ.iso', 'archive', 4.6 * GiB, 410, 'Архивы');
    add('Материалы курса.zip', 'archive', 1.4 * GiB, 15);
    add('Установщик.exe', 'executable', 1.1 * GiB, 220);
    add('Фотографии — оригиналы.psd', 'image', 760 * MiB, 12);
    add('Подкаст — запись.wav', 'audio', 920 * MiB, 62);
    add('Каталог.pdf', 'document', 82 * MiB, 32);
    add('Проект.blend', 'other', 320 * MiB, 83);
    for (let i = 0; i < 960; i++) {
      const category = categories[(i * 7 + 3) % 8]!;
      const ext: Record<Category, string> = { video: 'mp4', image: 'jpg', audio: 'mp3', document: 'pdf', archive: 'zip', code: 'ts', executable: 'msi', other: 'dat' };
      const age = [2, 18, 50, 200, 460][(i * 3) % 5]!;
      const name = category === 'image' && i % 3 === 0 ? `Снимок экрана 2026-03-${String(i % 28 + 1).padStart(2, '0')} ${i}.png` : `${category === 'document' ? 'Документ' : category === 'image' ? 'Фото' : 'Файл'} ${String(i + 1).padStart(3, '0')}.${ext[category]}`;
      add(name, category, (0.1 + ((i * 17) % 75) / 5) * MiB, age, category === 'image' ? 'Изображения' : 'Разное');
    }
    add('Пустой файл.txt', 'document', 0, 1);
    return rows;
  }
  private registerDirectories(): void {
    this.directories.clear(); this.directoryIds.clear(); this.directories.set(0, { id: 0, name: 'Загрузки', path: '', parent: null }); this.directoryIds.set('', 0);
    let next = 1;
    for (const file of this.files) {
      const parts = file.relativePath.split('/').slice(0, -1); let path = ''; let parent = 0;
      for (const name of parts) { path = path ? `${path}/${name}` : name; let id = this.directoryIds.get(path); if (id === undefined) { id = next++; this.directoryIds.set(path, id); this.directories.set(id, { id, name, path, parent }); } parent = id; }
    }
  }
  private check(id: number): void { if (id !== this.scanId) throw new Error('Эта карта устарела.'); }
  private idle(): void { if (busy(this.phase)) throw new Error('Сначала завершите текущую операцию.'); }
  private get(id: number): FileSummary { const file = this.files.find((f) => f.id === id); if (!file) throw new Error('Файл отсутствует.'); return file; }
  async chooseFolder(discardPlan = false): Promise<number> {
    this.idle();
    if (this.plan.size && !discardPlan) throw new Error('Сначала очистите или примените список удаления.');
    clearTimeout(this.timer); this.scanId++; this.revision++; this.files = this.makeFiles();
    if (discardPlan) { this.plan.clear(); this.planRevision++; } this.registerDirectories(); this.duplicatesFound = false; this.phase = 'scanning';
    this.operation = { total: 0, completed: 0, succeeded: 0, failed: 0, errors: [] };
    this.timer = setTimeout(() => { this.phase = 'ready'; this.revision++; }, 250);
    return this.scanId;
  }
  async rescan(id: number, discardPlan = false): Promise<number> { this.check(id); return this.chooseFolder(discardPlan); }
  async currentStatus(): Promise<Status | null> { return this.scanId ? this.status(this.scanId) : null; }
  async status(id: number): Promise<Status> {
    this.check(id);
    const duplicateFiles = this.files.filter((f) => f.duplicateGroup !== null);
    return { scanId: this.scanId, revision: this.revision, root: '/Демонстрация/Загрузки', phase: this.phase, files: this.files.length,
      logicalBytes: this.files.reduce((sum, f) => sum + f.logicalBytes, 0), allocatedBytes: this.files.reduce((sum, f) => sum + f.chargedBytes, 0),
      approximateCount: 0, skippedLinks: 2, skippedSpecial: 0, issuesCount: 0, issues: [], elapsedMs: 250, currentPath: '',
      hashBytes: this.duplicatesFound ? 34 * GiB : 0, hashFiles: this.duplicatesFound ? 12 : 0, hashCandidates: this.duplicatesFound ? 12 : 0,
      duplicateGroups: new Set(duplicateFiles.map((f) => f.duplicateGroup)).size, duplicateFiles: duplicateFiles.length,
      planCount: this.plan.size, planBytes: [...this.plan].reduce((sum, id) => sum + this.get(id).logicalBytes, 0), planRevision: this.planRevision, operation: structuredClone(this.operation) };
  }
  async query(id: number, filter: Filter, offset: number): Promise<View> {
    this.check(id);
    const size = (f: FileSummary) => filter.metric === 'allocated' ? f.chargedBytes : f.logicalBytes;
    const now = Date.now(), text = filter.text.toLowerCase();
    const files = this.files.filter((f) => (!filter.category || f.category === filter.category) && size(f) >= filter.minBytes
      && (!filter.duplicatesOnly || f.duplicateGroup !== null) && (!filter.screenshotsOnly || f.screenshot)
      && (filter.duplicateGroup === null || filter.duplicateGroup === f.duplicateGroup)
      && (filter.olderDays === null || (f.modifiedMs !== null && now - f.modifiedMs >= filter.olderDays * 86_400_000))
      && f.relativePath.toLowerCase().includes(text)
      && (!filter.bucket || (f.category === filter.bucket.category && f.ageBucket === filter.bucket.age && f.screenshot === filter.bucket.screenshot
        && (size(f) < filter.bucket.after.bytes || (size(f) === filter.bucket.after.bytes && f.id > filter.bucket.after.id)))))
      .sort((a, b) => size(b) - size(a) || a.id - b.id);
    const currentId = filter.directoryId ?? 0;
    const currentDir = this.directories.get(currentId);
    if (!currentDir) throw new Error('Неизвестная папка.');
    const crumbs: { id: number; name: string }[] = []; for (let d: typeof currentDir | undefined = currentDir; d;) { crumbs.unshift({ id: d.id, name: d.name }); d = d.parent === null ? undefined : this.directories.get(d.parent); }
    if (filter.folders) {
      const prefix = currentDir.path ? `${currentDir.path}/` : '';
      const inside = files.filter((f) => f.relativePath.startsWith(prefix));
      const entries = new Map<string, { directoryId: number | null; file: FileSummary | null; name: string; bytes: number; count: number }>();
      for (const file of inside) {
        const rest = file.relativePath.slice(prefix.length); const slash = rest.indexOf('/');
        if (slash < 0) entries.set(rest, { directoryId: null, file, name: file.name, bytes: size(file), count: 1 });
        else { const name = rest.slice(0, slash); const dir = this.directoryIds.get(prefix ? `${currentDir.path}/${name}` : name)!; const prior = entries.get(name) ?? { directoryId: dir, file: null, name, bytes: 0, count: 0 }; prior.bytes += size(file); prior.count++; entries.set(name, prior); }
      }
      const activeFilter = Boolean(filter.text || filter.category || filter.minBytes || filter.olderDays !== null || filter.duplicatesOnly || filter.screenshotsOnly || filter.duplicateGroup !== null || filter.bucket);
      if (!activeFilter) for (const dir of this.directories.values()) if (dir.parent === currentId && !entries.has(dir.name)) entries.set(dir.name, { directoryId: dir.id, file: null, name: dir.name, bytes: 0, count: 0 });
      const ordered = [...entries.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)); const entryOffset = Math.min(offset, Math.floor(Math.max(0, ordered.length - 1) / 200) * 200);
      const page = ordered.slice(entryOffset, entryOffset + 200);
      const directFiles = page.flatMap(entry => entry.file ? [entry.file] : []);
      return { scanId: id, revision: this.revision, total: inside.length, bytes: inside.reduce((sum, f) => sum + size(f), 0), offset: entryOffset, files: structuredClone(directFiles), nodes: [], categories: [], directoryId: currentId, breadcrumbs: crumbs, entries: structuredClone(page), entryTotal: ordered.length };
    }
    const nodes: MapNode[] = files.slice(0, 480).map((f) => ({ key: `f${f.id}`, label: f.name, bytes: size(f), count: 1, category: f.category,
      ageBucket: f.ageBucket, fileId: f.id, duplicateGroup: f.duplicateGroup, screenshot: f.screenshot, bucket: null }));
    if (files.length > 480) {
      const last = files[479]!;
      const groups = new Map<string, MapNode>();
      for (const f of files.slice(480)) {
        const key = `g${f.category}${f.ageBucket}${f.screenshot}`;
        let node = groups.get(key);
        if (!node) {
          const bucket: Bucket = { category: f.category, age: f.ageBucket, screenshot: f.screenshot, after: { bytes: size(last), id: last.id } };
          node = { key, label: '', bytes: 0, count: 0, category: f.category, ageBucket: f.ageBucket, fileId: null, duplicateGroup: null, screenshot: f.screenshot, bucket };
          groups.set(key, node);
        }
        node.count++; node.bytes += size(f); node.label = `Ещё ${node.count} файлов`;
      }
      nodes.push(...groups.values());
    }
    offset = Math.min(offset, Math.floor(Math.max(0, files.length - 1) / 200) * 200);
    return { scanId: id, revision: this.revision, total: files.length, bytes: files.reduce((sum, f) => sum + size(f), 0), offset,
      files: structuredClone(files.slice(offset, offset + 200)), nodes,
      categories: categories.map((category) => ({ category, bytes: files.filter((f) => f.category === category).reduce((sum, f) => sum + size(f), 0), count: files.filter((f) => f.category === category).length })).filter((g) => g.count > 0), directoryId: 0, breadcrumbs: [{ id: 0, name: 'Загрузки' }], entries: [], entryTotal: 0 };
  }
  async details(id: number, fileId: number): Promise<FileDetail> {
    this.check(id); const file = this.get(fileId);
    const duplicates = this.files.filter((f) => f.id !== fileId && file.duplicateGroup !== null && file.duplicateGroup === f.duplicateGroup);
    return structuredClone({ file, path: `/Демонстрация/Загрузки/${file.relativePath}`, duplicates: duplicates.slice(0, 50), duplicateCount: duplicates.length });
  }
  async cancel(id: number): Promise<void> { this.check(id); clearTimeout(this.timer); this.phase = 'cancelled'; this.revision++; }
  async findDuplicates(id: number): Promise<void> {
    this.check(id); this.idle(); this.phase = 'hashing';
    this.timer = setTimeout(() => {
      this.files.forEach((f) => { f.duplicateGroup = f.id <= 1 ? 1 : null; });
      this.duplicatesFound = true; this.phase = 'ready'; this.revision++;
    }, 400);
  }
  async planAdd(id: number, ids: number[]): Promise<PlanPage> {
    this.check(id); this.idle(); ids.forEach((id) => this.get(id));
    const next = new Set([...this.plan, ...ids]); if (next.size > 10_000) throw new Error('В плане не может быть больше 10 000 файлов.');
    this.plan = next; this.planRevision++; return this.planPage(id, 0);
  }
  async planRemove(id: number, ids: number[]): Promise<PlanPage> { this.check(id); this.idle(); ids.forEach((id) => this.plan.delete(id)); this.planRevision++; return this.planPage(id, 0); }
  async planClear(id: number): Promise<void> { this.check(id); this.idle(); this.plan.clear(); this.planRevision++; }
  async planPage(id: number, offset: number): Promise<PlanPage> {
    this.check(id); const files = [...this.plan].sort((a, b) => a - b).map((id) => this.get(id));
    offset = Math.min(offset, Math.floor(Math.max(0, files.length - 1) / 200) * 200);
    return { revision: this.planRevision, count: files.length, logicalBytes: files.reduce((sum, f) => sum + f.logicalBytes, 0), offset, files: structuredClone(files.slice(offset, offset + 200)) };
  }
  async executePlan(id: number, revision: number): Promise<void> {
    this.check(id); this.idle(); if (revision !== this.planRevision) throw new Error('Список изменился. Подтвердите его заново.');
    if (!this.plan.size) throw new Error('Список пуст.');
    this.phase = 'deleting'; this.operation = { total: this.plan.size, completed: 0, succeeded: 0, failed: 0, errors: [] };
    this.timer = setTimeout(() => {
      this.files = this.files.filter((f) => !this.plan.has(f.id)); this.operation.completed = this.operation.total; this.operation.succeeded = this.operation.total;
      const counts = new Map<number, number>();
      for (const f of this.files) if (f.duplicateGroup !== null) counts.set(f.duplicateGroup, (counts.get(f.duplicateGroup) ?? 0) + 1);
      for (const f of this.files) if (f.duplicateGroup !== null && (counts.get(f.duplicateGroup) ?? 0) < 2) f.duplicateGroup = null;
      this.plan.clear(); this.planRevision++; this.phase = 'ready'; this.revision++;
    }, 250);
  }
  async open(id: number, fileId: number, allowExecutable: boolean): Promise<void> {
    this.check(id); const file = this.get(fileId);
    if (file.executable && !allowExecutable) throw new Error('Подтвердите запуск программы.');
    throw new Error('Это пример: настоящие файлы не открываются.');
  }
  async reveal(id: number, fileId: number): Promise<void> { this.check(id); this.get(fileId); throw new Error('Это пример: системный файловый менеджер не запускается.'); }
}
