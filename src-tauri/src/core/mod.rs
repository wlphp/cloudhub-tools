pub mod crypto;
#[cfg(desktop)]
pub mod mail;
pub mod ai;
pub mod ai_stream;
pub mod ai_images;
pub mod ai_models;
pub mod ai_transfer;
#[cfg(desktop)]
pub mod codex;
pub mod authenticator;
pub mod claude_providers;
#[cfg(desktop)]
pub mod claude_gateway;
#[cfg(desktop)]
pub mod claude_protocol;
#[cfg(desktop)]
pub mod claude_workspace;
pub mod database;
pub mod data_transfer;
pub mod speed_test;
#[cfg(desktop)]
pub mod browser;
pub mod error;
pub mod paths;
pub mod network;
#[cfg(any(desktop, mobile))]
pub mod pet_alerts;
#[cfg(any(desktop, mobile))]
pub mod pet_life;
pub mod repositories;
pub mod lan;
pub mod sync_identity;

// Compatibility facade for existing command code while the remaining repositories migrate.
pub mod storage {
    pub use super::crypto::{decrypt_secret, encrypt_secret};
    pub use super::database::open_db;
    pub use super::paths::data_dir;
}
