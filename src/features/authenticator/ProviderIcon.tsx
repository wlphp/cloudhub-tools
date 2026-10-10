import { KeyRound } from "lucide-react";
import googleLogo from "./assets/google.svg";
import openaiLogo from "./assets/openai.svg";

/** Bundled brand assets: never request an icon using account or issuer data. */
export function ProviderIcon({ issuer }: { issuer: string }) {
  const provider = issuer.trim().toLowerCase();
  const logo = ["google", "google.com", "gmail"].includes(provider) ? googleLogo
    : ["openai", "openai.com", "chatgpt"].includes(provider) ? openaiLogo : null;
  return <span className="auth-provider-icon" aria-hidden="true">
    {logo ? <img src={logo} alt="" width={26} height={26} draggable={false} /> : <KeyRound size={24} />}
  </span>;
}
