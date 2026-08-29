import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import "./ide-theme.css";

// Remove the static bootstrap shell as soon as React commits the first frame.
// Doing this inside an effect (rather than requestAnimationFrame) guarantees the
// shell only goes away after React has actually mounted, so a render error never
// leaves a half-loaded red box on screen.
function clearBootstrap() {
  const node = document.getElementById("app-bootstrap");
  if (node) node.remove();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App onReady={clearBootstrap} />
    </AppErrorBoundary>
  </React.StrictMode>,
);

// Safety net: if React has not committed within 12s (e.g. a top-level import throws
// synchronously before mount), surface a recoverable error state instead of leaving
// the user staring at a blank dark window.
setTimeout(() => {
  if (document.getElementById("app-bootstrap")) {
    const root = document.getElementById("root");
    if (root && !root.firstElementChild) {
      const message = document.createElement("div");
      message.className = "app-boot-timeout";
      message.setAttribute("role", "status");
      message.innerHTML = "<h2>界面加载超时</h2><p>请重新启动应用或在终端查看错误日志。</p>";
      root.appendChild(message);
    }
  }
}, 12000);
