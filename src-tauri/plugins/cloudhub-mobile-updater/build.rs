fn main() {
    tauri_plugin::Builder::new(&["check", "download", "cancel", "install"])
        .android_path("android")
        .build();
}
