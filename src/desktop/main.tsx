import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
const query = new URLSearchParams(window.location.search);
const desktopPet = query.get("desktopPet") === "1";
if (desktopPet) document.documentElement.classList.add("pet-window-page");
const Root = lazy(() => desktopPet ? import("../features/desktop-pet/PetWindow").then(m => ({ default: m.PetWindow })) : query.get("desktopPetAlerts") === "1" ? import("../features/desktop-pet/PetAlertWindow").then(m => ({ default: m.PetAlertWindow })) : import("../App"));
import "../App.css";
import "../summary.css";
import "../server.css";
import "../domain.css";
import "../domain-tools.css";
import "../local-assets.css";
import "../settings-compact.css";
import "../terminal-workbench.css";
import "../ide-theme.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}><Root /></Suspense>
  </React.StrictMode>,
);
