use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::Error;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<CloudhubKeystore<R>> {
  Ok(CloudhubKeystore(app.clone()))
}

/// Access to the cloudhub-keystore APIs.
pub struct CloudhubKeystore<R: Runtime>(AppHandle<R>);

impl<R: Runtime> CloudhubKeystore<R> {
  pub fn load_key(&self) -> crate::Result<Option<Vec<u8>>> { Err(Error::UnsupportedPlatform) }
  pub fn store_key(&self, _key: &[u8]) -> crate::Result<()> { Err(Error::UnsupportedPlatform) }
  pub fn load_sync_identity_seed(&self) -> crate::Result<Option<Vec<u8>>> { Err(Error::UnsupportedPlatform) }
  pub fn store_sync_identity_seed(&self, _seed: &[u8]) -> crate::Result<()> { Err(Error::UnsupportedPlatform) }
}
