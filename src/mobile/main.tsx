import React from "react";
import ReactDOM from "react-dom/client";
import { MobileApp } from "./MobileApp";
import { StartupSplash } from "../features/app/StartupSplash";
import { preferencesClient } from "../platform/clients/preferences";
import "./mobile-actions.css";
import "./mobile-domains.css";
import "../shared/dialogs.css";
import "./mobile.css";
import "./mobile-dialogs.css";
import "../features/app/startup-splash.css";

function MobileBootstrap() {
  const [showSplash, setShowSplash] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let active = true;
    void preferencesClient.list()
      .then((preferences) => { if (active) setShowSplash(preferences["cloudhub-startup-animation"] !== "0"); })
      .catch(() => { if (active) setShowSplash(false); });
    return () => { active = false; };
  }, []);
  if (showSplash === null) return null;
  return showSplash ? <StartupSplash onComplete={() => setShowSplash(false)} /> : <MobileApp />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode><MobileBootstrap /></React.StrictMode>);
