if (import.meta.env.VITE_APP_TARGET === "mobile") {
  void import("./mobile/main");
} else {
  void import("./desktop/main");
}
