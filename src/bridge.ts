import { ui } from './i18n.js';
import type { Backend, FileDetail, Filter, PlanPage, Status, View } from './types.js';
interface TauriGlobal { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } }
declare global { interface Window { __TAURI__?: TauriGlobal } }
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.__TAURI__) return Promise.reject(new Error(ui('Для работы с файлами запустите настольное приложение.')));
  return window.__TAURI__.core.invoke<T>(command, args);
}
export class NativeBackend implements Backend {
  readonly demo = false;
  chooseFolder(discardPlan = false) { return invoke<number | null>('choose_folder', { discardPlan }); }
  rescan(scanId: number, discardPlan = false) { return invoke<number>('rescan', { scanId, discardPlan }); }
  currentStatus() { return window.__TAURI__ ? invoke<Status | null>('get_current_status') : Promise.resolve(null); }
  status(scanId: number) { return invoke<Status>('get_status', { scanId }); }
  query(scanId: number, filter: Filter, offset: number) { return invoke<View>('query_view', { scanId, filter, offset }); }
  details(scanId: number, id: number) { return invoke<FileDetail>('get_details', { scanId, id }); }
  cancel(scanId: number) { return invoke<void>('cancel_job', { scanId }); }
  findDuplicates(scanId: number) { return invoke<void>('find_duplicates', { scanId }); }
  planAdd(scanId: number, ids: number[]) { return invoke<PlanPage>('plan_add', { scanId, ids }); }
  planRemove(scanId: number, ids: number[]) { return invoke<PlanPage>('plan_remove', { scanId, ids }); }
  planClear(scanId: number) { return invoke<void>('plan_clear', { scanId }); }
  planPage(scanId: number, offset: number) { return invoke<PlanPage>('get_plan', { scanId, offset }); }
  executePlan(scanId: number, planRevision: number) { return invoke<void>('execute_plan', { scanId, planRevision }); }
  open(scanId: number, id: number, allowExecutable: boolean) { return invoke<void>('open_file', { scanId, id, allowExecutable }); }
  reveal(scanId: number, id: number) { return invoke<void>('reveal_file', { scanId, id }); }
}
