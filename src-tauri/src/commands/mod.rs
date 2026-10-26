pub mod accounts;
#[cfg(desktop)]
pub mod claude_workbench;
#[cfg(desktop)]
pub mod browser;
#[cfg(desktop)]
pub mod wechat_plugin;
#[cfg(desktop)]
pub mod wechat_sessions;
#[cfg(desktop)]
pub mod wechat_data_detection;
#[cfg(desktop)]
pub mod hardware_info;
#[cfg(desktop)]
pub mod wsl_dashboard;
pub mod ai;
pub mod ai_transfer;
#[cfg(desktop)]
pub mod codex;
#[cfg(desktop)]
pub mod codex_config;
#[cfg(desktop)]
pub mod codex_providers;
#[cfg(desktop)]
pub mod codex_details;
#[cfg(desktop)]
pub mod codex_runtime;
#[cfg(desktop)]
pub mod codex_instances;
#[cfg(desktop)]
pub mod codex_backup;
#[cfg(desktop)]
pub mod codex_gateway;
pub mod authenticator;
pub mod preferences;
#[cfg(desktop)]
pub mod network;
pub mod cloud_sync;
pub mod logs;
pub mod assets;
pub mod managed_hosts;
pub mod panel_connections;
pub mod connections;
pub mod database_migration;
pub mod app;
pub mod domains;
pub mod storage;
pub mod resources;
pub mod servers;
pub mod ssh;
pub mod providers;
pub mod summary;
pub mod certificates;
pub mod certificate_import;
pub mod baota_certificates;
pub mod flow;
pub mod frp;
pub mod sync;

pub mod esa_certificates;
#[cfg(desktop)]
pub mod desktop_pet;
#[cfg(desktop)]
pub mod notes;
pub mod trash;
pub mod claude_providers;
