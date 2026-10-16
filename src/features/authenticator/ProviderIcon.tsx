import { KeyRound } from "lucide-react";
import googleLogo from "./assets/google.svg";
import openaiLogo from "./assets/openai.svg";
import microsoftLogo from "./assets/microsoft.svg";
import oracleLogo from "./assets/oracle.svg";
import githubLogo from "./assets/github.svg";

/** Bundled brand assets: never request an icon using account or issuer data. */
export function ProviderIcon({ issuer }: { issuer: string }) {
  const provider = issuer.trim().toLowerCase();
  const logo = ["google", "google.com", "gmail"].includes(provider) ? googleLogo
    : ["openai", "openai.com", "chatgpt"].includes(provider) ? openaiLogo
    : ["microsoft", "microsoft.com", "microsoft account", "azure", "azure ad", "office365", "office 365", "outlook", "live"].includes(provider) ? microsoftLogo
    : ["oracle", "oracle.com", "oracle cloud", "oci"].includes(provider) ? oracleLogo
    : ["github", "github.com", "gh"].includes(provider) ? githubLogo : null;
  return <span className="auth-provider-icon" aria-hidden="true">
    {logo ? <img src={logo} alt="" width={26} height={26} draggable={false} /> : <KeyRound size={24} />}
  </span>;
}
