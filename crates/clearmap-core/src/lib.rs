//! UI-independent, local-only filesystem core. No shell commands or network client.
mod duplicates;
pub mod engine;
pub mod metadata;
pub mod model;
pub mod operations;
pub mod query;
mod scanner;
pub use engine::Engine;

// The sole unsafe boundary: documented calls to Windows COM. The rest of the
// project denies unsafe Rust; this module owns COM initialization and pointers.
#[cfg(windows)]
#[allow(unsafe_code)]
mod trash_windows;
