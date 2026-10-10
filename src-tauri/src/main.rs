// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(desktop)]
    if std::env::args().nth(1).as_deref() == Some("--browser-authenticator") {
        cloudhub_tools_lib::run_browser_authenticator();
        return;
    }
    cloudhub_tools_lib::run()
}
