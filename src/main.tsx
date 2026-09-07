import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import "./summary.css";
import "./server.css";
import "./domain.css";
import "./domain-tools.css";
import "./local-assets.css";
import "./settings-compact.css";
import "./terminal-workbench.css";
import "./ide-theme.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
