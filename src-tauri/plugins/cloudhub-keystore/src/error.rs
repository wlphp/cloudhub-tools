use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
  #[error(transparent)]
  Io(#[from] std::io::Error),
  #[error("移动端系统安全存储不可用")]
  UnsupportedPlatform,
  #[error("本地密钥格式无效")]
  InvalidKey,
  #[cfg(mobile)]
  #[error(transparent)]
  PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for Error {
  fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
  where
    S: Serializer,
  {
    serializer.serialize_str(self.to_string().as_ref())
  }
}
