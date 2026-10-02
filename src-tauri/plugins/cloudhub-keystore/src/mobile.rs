use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::Error;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreKeyRequest<'a> { key: &'a str }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupPathRequest<'a> { path: &'a str }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadKeyResponse { key: Option<String> }

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_cloudhub_keystore);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<CloudhubKeystore<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("com.cloudhub.securestore", "SecureStorePlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_cloudhub_keystore)?;
  Ok(CloudhubKeystore(handle))
}

/// Access to the cloudhub-keystore APIs.
pub struct CloudhubKeystore<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> CloudhubKeystore<R> {
  pub fn exclude_data_from_backup(&self, path: &str) -> crate::Result<()> {
    self.0.run_mobile_plugin::<serde_json::Value>("excludeDataFromBackup", BackupPathRequest { path })?;
    Ok(())
  }

  pub fn load_key(&self) -> crate::Result<Option<Vec<u8>>> {
    let response: LoadKeyResponse = self.0.run_mobile_plugin("loadKey", serde_json::json!({}))?;
    response.key.map(|mut value| {
      let decoded = B64.decode(value.as_bytes());
      value.zeroize();
      let key = decoded.map_err(|_| Error::InvalidKey)?;
      if key.len() != 32 { return Err(Error::InvalidKey); }
      Ok(key)
    }).transpose()
  }

  pub fn store_key(&self, key: &[u8]) -> crate::Result<()> {
    if key.len() != 32 { return Err(Error::InvalidKey); }
    let mut encoded = B64.encode(key);
    let result = self.0.run_mobile_plugin::<serde_json::Value>("storeKey", StoreKeyRequest { key: &encoded });
    encoded.zeroize();
    result?;
    Ok(())
  }

  pub fn load_sync_identity_seed(&self) -> crate::Result<Option<Vec<u8>>> {
    let response: LoadKeyResponse = self.0.run_mobile_plugin("loadSyncIdentitySeed", serde_json::json!({}))?;
    response.key.map(decode_secret).transpose()
  }

  pub fn store_sync_identity_seed(&self, seed: &[u8]) -> crate::Result<()> {
    if seed.len() != 32 { return Err(Error::InvalidKey); }
    let mut encoded = B64.encode(seed);
    let result = self.0.run_mobile_plugin::<serde_json::Value>("storeSyncIdentitySeed", StoreKeyRequest { key: &encoded });
    encoded.zeroize();
    result?;
    Ok(())
  }
}

fn decode_secret(mut value: String) -> crate::Result<Vec<u8>> {
  let decoded = B64.decode(value.as_bytes());
  value.zeroize();
  let key = decoded.map_err(|_| Error::InvalidKey)?;
  if key.len() != 32 { return Err(Error::InvalidKey); }
  Ok(key)
}
