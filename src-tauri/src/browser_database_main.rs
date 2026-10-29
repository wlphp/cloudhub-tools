#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(desktop)]
    cloudhub_tools_lib::run_browser_database();
}
