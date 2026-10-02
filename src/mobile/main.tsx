import React from "react";
import ReactDOM from "react-dom/client";
import { MobileApp } from "./MobileApp";
import "./mobile.css";
import "./mobile-actions.css";
import "./mobile-domains.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
