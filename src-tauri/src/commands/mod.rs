pub mod cloudflare;
pub mod accounts;
pub mod member;
#[cfg(desktop)]
pub mod cloud_drive;
#[cfg(desktop)]
pub mod mail;
pub mod speed_test;
pub mod ip_location;
pub mod icp;
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
#[cfg(desktop)]
pub mod startup_manager;
#[cfg(desktop)]
pub mod windows_toolbox;
pub mod ai;
pub mod ai_transfer;
#[cfg(desktop)]
pub mod codex;
#[cfg(desktop)]
pub mod codex_config;
#[cfg(desktop)]
pub mod codex_providers;
#[cfg(desktop)]
pub mod codex_history;
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
pub mod network;
#[cfg(desktop)]
pub mod http_debug_proxy;
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
#[cfg(desktop)]
pub mod env_manager;
pub mod certificate_import;
pub mod baota_certificates;
pub mod flow;
pub mod frp;
pub mod sync;

pub mod esa_certificates;
#[cfg(desktop)]
pub mod desktop_pet;
#[cfg(mobile)]
#[path = "desktop_pet.rs"]
// The mobile module exports only monitor-alert commands; desktop pet APIs are cfg-gated.
pub mod monitoring;
pub mod notes;
pub mod trash;
pub mod claude_providers;
pub mod lan;
