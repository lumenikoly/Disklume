fn main() {
    const COMMANDS: &[&str] = &[
        "set_language",
        "choose_folder",
        "rescan",
        "get_status",
        "get_current_status",
        "query_view",
        "get_details",
        "cancel_job",
        "find_duplicates",
        "plan_add",
        "plan_remove",
        "plan_clear",
        "get_plan",
        "execute_plan",
        "open_file",
        "reveal_file",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("Не удалось подготовить сборку Tauri");
}
