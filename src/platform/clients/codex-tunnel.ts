import { nativeOnly } from "./base";

export type CodexTunnelConfig = { enabled: boolean; mode: "https" | "http" | "tcp"; serverId: number | null; domain: string; publicPort: number; certificatePath: string; privateKeyPath: string; trustedCaPath: string; tlsServerName: string; ruleName: string };
export type CodexTunnelState = { config: CodexTunnelConfig; installed: boolean; running: boolean; connected: boolean; localPort: number | null; publicUrl: string | null; error: string | null; logs: string[] };
export const codexTunnelClient = {
  state: (): Promise<CodexTunnelState> => nativeOnly("codex_tunnel_state"),
  save: (config: CodexTunnelConfig): Promise<CodexTunnelState> => nativeOnly("codex_tunnel_save", { config }),
  retry: (): Promise<CodexTunnelState> => nativeOnly("codex_tunnel_retry"),
};
