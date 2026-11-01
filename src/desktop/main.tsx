import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
const query = new URLSearchParams(window.location.search);
const desktopPet = query.get("desktopPet") === "1";
if (desktopPet) document.documentElement.classList.add("pet-window-page");
const startup = query.get("startup") === "1";
if (startup) document.documentElement.classList.add("startup-splash-page");
const Root = lazy(() => startup ? import("../features/app/StartupSplash").then(m => ({ default: m.StartupSplash })) : desktopPet ? import("../features/desktop-pet/PetWindow").then(m => ({ default: m.PetWindow })) : query.get("desktopPetAlerts") === "1" ? import("../features/desktop-pet/PetAlertWindow").then(m => ({ default: m.PetAlertWindow })) : import("../App"));
import "../App.css";
import "../summary.css";
import "../server.css";
import "../domain.css";
import "../domain-tools.css";
import "../local-assets.css";
import "../settings-compact.css";
import "../terminal-workbench.css";
import "../ide-theme.css";
import "../features/app/startup-splash.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}><Root /></Suspense>
  </React.StrictMode>,
);
