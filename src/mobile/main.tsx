import React from "react";
import ReactDOM from "react-dom/client";
import { MobileApp } from "./MobileApp";
import "./mobile-actions.css";
import "./mobile-domains.css";
import "../shared/dialogs.css";
import "./mobile.css";
import "./mobile-dialogs.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
