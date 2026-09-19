use clearmap_core::Engine;
use std::{path::PathBuf, time::Duration};
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("Использование: clearmap-scan <папка>")?;
    let engine = Engine::new(std::env::temp_dir().join("clearmap-cli-audit"));
    let id = engine.start_scan(&path)?;
    loop {
        let status = engine.status(id)?;
        if !status.phase.busy() {
            println!(
                "{}",
                serde_json::to_string_pretty(&status).map_err(|e| e.to_string())?
            );
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}
