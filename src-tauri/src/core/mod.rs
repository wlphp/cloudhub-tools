pub mod crypto;
pub mod database;
pub mod paths;
pub mod repositories;

// Compatibility facade for existing command code while the remaining repositories migrate.
pub mod storage {
    pub use super::crypto::{decrypt_secret, encrypt_secret};
    pub use super::database::open_db;
    pub use super::paths::data_dir;
}
