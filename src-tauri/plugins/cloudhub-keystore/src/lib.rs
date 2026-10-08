use tauri::{plugin::{Builder, TauriPlugin}, Manager, Runtime};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::CloudhubKeystore;
#[cfg(mobile)]
use mobile::CloudhubKeystore;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the cloudhub-keystore APIs.
pub trait CloudhubKeystoreExt<R: Runtime> {
  fn cloudhub_keystore(&self) -> &CloudhubKeystore<R>;
}

impl<R: Runtime, T: Manager<R>> crate::CloudhubKeystoreExt<R> for T {
  fn cloudhub_keystore(&self) -> &CloudhubKeystore<R> {
    self.state::<CloudhubKeystore<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("cloudhub-keystore")
    .setup(|app, api| {
      #[cfg(mobile)]
      let cloudhub_keystore = mobile::init(app, api)?;
      #[cfg(desktop)]
      let cloudhub_keystore = desktop::init(app, api)?;
      app.manage(cloudhub_keystore);
      Ok(())
    })
    .build()
}

/// The device-local database key is only accessible to Rust callers. No guest
/// JavaScript command is registered for reading or writing it.
pub fn load_key<R: Runtime, T: Manager<R>>(manager: &T) -> Result<Option<Vec<u8>>> {
  manager.cloudhub_keystore().load_key()
}

pub fn store_key<R: Runtime, T: Manager<R>>(manager: &T, key: &[u8]) -> Result<()> {
  manager.cloudhub_keystore().store_key(key)
}

/// Device-local signing seed used only by Rust synchronization commands.
pub fn load_sync_identity_seed<R: Runtime, T: Manager<R>>(manager: &T) -> Result<Option<Vec<u8>>> {
  manager.cloudhub_keystore().load_sync_identity_seed()
}

pub fn store_sync_identity_seed<R: Runtime, T: Manager<R>>(manager: &T, seed: &[u8]) -> Result<()> {
  manager.cloudhub_keystore().store_sync_identity_seed(seed)
}

#[cfg(mobile)]
pub fn exclude_data_from_backup<R: Runtime, T: Manager<R>>(manager: &T, path: &str) -> Result<()> {
  manager.cloudhub_keystore().exclude_data_from_backup(path)
}
