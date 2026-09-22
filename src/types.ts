export type Category = 'video' | 'image' | 'audio' | 'document' | 'archive' | 'code' | 'executable' | 'other';
export type Metric = 'logical' | 'allocated';
export type Phase = 'scanning' | 'ready' | 'cancelled' | 'hashing' | 'deleting' | 'failed';
export interface FileSummary {
  id: number; name: string; relativePath: string; category: Category;
  logicalBytes: number; allocatedBytes: number | null; chargedBytes: number;
  modifiedMs: number | null; ageBucket: number; screenshot: boolean;
  hardLink: boolean; executable: boolean; duplicateGroup: number | null; actionable: boolean;
}
export interface FileDetail { file: FileSummary; path: string; duplicates: FileSummary[]; duplicateCount: number }
export interface Cursor { bytes: number; id: number }
export interface Bucket { category: Category; age: number; screenshot: boolean; after: Cursor; through: Cursor }
export interface Filter {
  text: string; category: Category | null; minBytes: number; olderDays: number | null;
  duplicatesOnly: boolean; screenshotsOnly: boolean; metric: Metric; bucket: Bucket | null; duplicateGroup: number | null;
  folders: boolean; directoryId: number | null;
}
export interface MapNode {
  key: string; label: string; bytes: number; count: number; category: Category;
  ageBucket: number; fileId: number | null; duplicateGroup: number | null; screenshot: boolean; bucket: Bucket | null;
}
export interface CategoryTotal { category: Category; bytes: number; count: number }
export interface DirectoryCrumb { id: number; name: string }
export interface DirectoryEntry { directoryId: number | null; file: FileSummary | null; name: string; bytes: number; count: number }
export interface View { scanId: number; revision: number; total: number; bytes: number; offset: number; files: FileSummary[]; nodes: MapNode[]; categories: CategoryTotal[]; directoryId: number; breadcrumbs: DirectoryCrumb[]; entries: DirectoryEntry[]; entryTotal: number }
export interface Issue { path: string; message: string }
export interface OperationProgress { total: number; completed: number; succeeded: number; failed: number; errors: Issue[] }
export interface Status {
  scanId: number; revision: number; root: string; phase: Phase;
  files: number; logicalBytes: number; allocatedBytes: number; approximateCount: number;
  skippedLinks: number; skippedSpecial: number; issuesCount: number; issues: Issue[];
  elapsedMs: number; currentPath: string; hashBytes: number; hashFiles: number;
  hashCandidates: number; duplicateGroups: number; duplicateFiles: number;
  planCount: number; planBytes: number; planRevision: number; operation: OperationProgress;
}
export interface PlanPage { revision: number; count: number; logicalBytes: number; offset: number; files: FileSummary[] }
export interface Backend {
  readonly demo: boolean;
  chooseFolder(discardPlan?: boolean): Promise<number | null>;
  rescan(scanId: number, discardPlan?: boolean): Promise<number>;
  currentStatus(): Promise<Status | null>;
  status(scanId: number): Promise<Status>;
  query(scanId: number, filter: Filter, offset: number): Promise<View>;
  details(scanId: number, id: number): Promise<FileDetail>;
  cancel(scanId: number): Promise<void>;
  findDuplicates(scanId: number): Promise<void>;
  planAdd(scanId: number, ids: number[]): Promise<PlanPage>;
  planRemove(scanId: number, ids: number[]): Promise<PlanPage>;
  planClear(scanId: number): Promise<void>;
  planPage(scanId: number, offset: number): Promise<PlanPage>;
  executePlan(scanId: number, planRevision: number): Promise<void>;
  open(scanId: number, id: number, allowExecutable: boolean): Promise<void>;
  reveal(scanId: number, id: number): Promise<void>;
  revealDirectory(scanId: number, id: number): Promise<void>;
}
export const defaultFilter = (): Filter => ({ text: '', category: null, minBytes: 0, olderDays: null, metric: 'allocated', bucket: null, duplicateGroup: null, duplicatesOnly: false, screenshotsOnly: false, folders: false, directoryId: null });
export const busy = (phase: Phase | undefined): boolean => phase === 'scanning' || phase === 'hashing' || phase === 'deleting';
