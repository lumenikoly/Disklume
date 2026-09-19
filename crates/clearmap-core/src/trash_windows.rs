//! Windows-only, trash-only adapter. Deliberately does not offer permanent delete.
use crate::model::Result;
use std::{
    os::windows::ffi::OsStrExt,
    path::{Component, Path, Prefix},
};
use windows::{
    core::PCWSTR,
    Win32::{
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
            FOFX_ADDUNDORECORD, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_NO_CONNECTED_ELEMENTS,
            FOF_NO_UI,
        },
    },
};

struct Apartment;
impl Apartment {
    fn enter() -> Result<Self> {
        // SAFETY: Called on the dedicated cleanup worker. Every successful COM
        // initialization (including S_FALSE) is balanced by Drop on this thread.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|e| format!("Не удалось подготовить системную Корзину: {e}"))?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: Apartment cannot leave this synchronous stack; COM interfaces
        // created below have already been released when this guard is dropped.
        unsafe { CoUninitialize() };
    }
}

pub(crate) fn put(path: &Path) -> Result<()> {
    // Do not blindly strip a verbatim prefix: reserved Windows names can resolve
    // to a different object. dunce leaves such paths unchanged; we reject them.
    let path = dunce::simplified(path);
    let ordinary_local = matches!(path.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)));
    if !ordinary_local || !path.has_root() {
        return Err("Корзина поддерживается только для обычных путей локального диска. Сетевые и специальные пути не удаляются.".into());
    }
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let _apartment = Apartment::enter()?;
    // SAFETY: The UTF-16 buffer is NUL-terminated and outlives all COM calls.
    // Interfaces stay on their initializing thread and are dropped before COM.
    let result: windows::core::Result<()> = unsafe {
        (|| {
            let operation: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
            // Recycle is explicit, not merely ALLOWUNDO (best effort). Disable
            // connected .html/_files moves: only the user's selected file moves.
            operation.SetOperationFlags(
                FOFX_RECYCLEONDELETE
                    | FOFX_ADDUNDORECORD
                    | FOF_NO_UI
                    | FOFX_EARLYFAILURE
                    | FOF_NO_CONNECTED_ELEMENTS,
            )?;
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)?;
            operation.DeleteItem(&item, None)?;
            operation.PerformOperations()?;
            if operation.GetAnyOperationsAborted()?.as_bool() {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80004004_u32 as i32,
                )));
            }
            Ok(())
        })()
    };
    result.map_err(|e| format!("Система не смогла переместить файл в Корзину. Безвозвратное удаление не выполнялось: {e}"))
}
