#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use clearmap_core::{model::*, Engine};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type AppState<'a> = State<'a, Arc<Engine>>;
#[derive(Default)]
struct Language(AtomicBool);
impl Language {
    fn text<'a>(&self, ru: &'a str, en: &'a str) -> &'a str {
        if self.0.load(Ordering::Relaxed) {
            en
        } else {
            ru
        }
    }
}
#[tauri::command]
fn set_language(state: State<'_, Language>, language: String) -> Result<()> {
    match language.as_str() {
        "ru" | "en" => {
            state.0.store(language == "en", Ordering::Relaxed);
            Ok(())
        }
        _ => Err("Unsupported language".into()),
    }
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("Внутренняя ошибка: {e}"))?
}
#[tauri::command]
async fn choose_folder(
    app: tauri::AppHandle,
    state: AppState<'_>,
    discard_plan: Option<bool>,
) -> Result<Option<u64>> {
    let engine = state.inner().clone();
    blocking(move || {
        if engine.current_status()?.is_some_and(|s| s.phase.busy()) {
            return Err("Сначала остановите текущую операцию.".into());
        }
        let Some(folder) = app
            .dialog()
            .file()
            .set_title(
                app.state::<Language>()
                    .text("Выберите папку", "Choose folder"),
            )
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let folder = folder.into_path().map_err(|e| e.to_string())?;
        engine
            .choose_scan(&folder, discard_plan.unwrap_or(false))
            .map(Some)
    })
    .await
}
#[tauri::command]
async fn rescan(state: AppState<'_>, scan_id: u64, discard_plan: Option<bool>) -> Result<u64> {
    let e = state.inner().clone();
    blocking(move || e.rescan_with_plan(scan_id, discard_plan.unwrap_or(false))).await
}
#[tauri::command]
async fn get_current_status(state: AppState<'_>) -> Result<Option<Status>> {
    let e = state.inner().clone();
    blocking(move || e.current_status()).await
}
#[tauri::command]
async fn get_status(state: AppState<'_>, scan_id: u64) -> Result<Status> {
    let e = state.inner().clone();
    blocking(move || e.status(scan_id)).await
}
#[tauri::command]
async fn query_view(
    state: AppState<'_>,
    scan_id: u64,
    filter: Filter,
    offset: usize,
) -> Result<View> {
    let e = state.inner().clone();
    blocking(move || e.query(scan_id, filter, offset)).await
}
#[tauri::command]
async fn get_details(state: AppState<'_>, scan_id: u64, id: u64) -> Result<FileDetail> {
    let e = state.inner().clone();
    blocking(move || e.details(scan_id, id)).await
}
#[tauri::command]
async fn cancel_job(state: AppState<'_>, scan_id: u64) -> Result<()> {
    let e = state.inner().clone();
    blocking(move || e.cancel(scan_id)).await
}
#[tauri::command]
async fn find_duplicates(state: AppState<'_>, scan_id: u64) -> Result<()> {
    let e = state.inner().clone();
    blocking(move || e.find_duplicates(scan_id)).await
}
#[tauri::command]
async fn plan_add(state: AppState<'_>, scan_id: u64, ids: Vec<u64>) -> Result<PlanPage> {
    let e = state.inner().clone();
    blocking(move || e.add_to_plan(scan_id, ids)).await
}
#[tauri::command]
async fn plan_remove(state: AppState<'_>, scan_id: u64, ids: Vec<u64>) -> Result<PlanPage> {
    let e = state.inner().clone();
    blocking(move || e.remove_from_plan(scan_id, ids)).await
}
#[tauri::command]
async fn plan_clear(state: AppState<'_>, scan_id: u64) -> Result<()> {
    let e = state.inner().clone();
    blocking(move || e.clear_plan(scan_id)).await
}
#[tauri::command]
async fn get_plan(state: AppState<'_>, scan_id: u64, offset: usize) -> Result<PlanPage> {
    let e = state.inner().clone();
    blocking(move || e.plan_page(scan_id, offset)).await
}
#[tauri::command]
async fn execute_plan(state: AppState<'_>, scan_id: u64, plan_revision: u64) -> Result<()> {
    let e = state.inner().clone();
    blocking(move || e.execute_plan(scan_id, plan_revision)).await
}
#[tauri::command]
async fn open_file(
    app: tauri::AppHandle,
    state: AppState<'_>,
    scan_id: u64,
    id: u64,
    allow_executable: bool,
) -> Result<()> {
    let e = state.inner().clone();
    blocking(move || {
        let path = e.checked_path(scan_id, id, allow_executable, false)?;
        // Do not silently change a non-UTF8 path into a different lossy string.
        let path = path.to_str().ok_or(
            "Системный модуль открытия не поддерживает это имя. Используйте «Показать в папке».",
        )?;
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|e| format!("Не удалось открыть файл: {e}"))
    })
    .await
}
#[tauri::command]
async fn reveal_file(
    app: tauri::AppHandle,
    state: AppState<'_>,
    scan_id: u64,
    id: u64,
) -> Result<()> {
    let e = state.inner().clone();
    blocking(move || {
        let path = e.checked_path(scan_id, id, false, true)?;
        app.opener()
            .reveal_item_in_dir(path)
            .map_err(|e| format!("Не удалось показать файл в системном менеджере: {e}"))
    })
    .await
}
fn main() {
    tauri::Builder::default()
        .manage(Language::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = app.path().app_local_data_dir()?.join("journal");
            app.manage(Arc::new(Engine::new(directory)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let engine = window.state::<Arc<Engine>>();
                if let Ok(Some(status)) = engine.current_status() {
                    if status.phase == Phase::Deleting {
                        api.prevent_close();
                        let language = window.state::<Language>();
                        window.app_handle().dialog()
                            .message(language.text("Сначала завершите или остановите перенос в Корзину. Уже выполненные действия останутся в силе.", "Finish or stop moving files to Trash before closing. Completed moves will remain in effect."))
                            .title(language.text("Идёт уборка", "Cleanup in progress")).show(|_| {});
                    } else if status.phase.busy() { let _ = engine.cancel(status.scan_id); }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![set_language, choose_folder, rescan, get_current_status, get_status, query_view, get_details, cancel_job, find_duplicates, plan_add, plan_remove, plan_clear, get_plan, execute_plan, open_file, reveal_file])
        .run(tauri::generate_context!())
        .expect("Не удалось запустить ClearMap");
}
