import { invokeOrWeb, jsonRequest } from "./base";

export type CloudflareAction = "verify" | "dns_list" | "dns_save" | "dns_delete" | "dns_proxy" | "purge_cache" | "ssl_get" | "ssl_set" | "r2_create" | "worker_create" | "worker_template_deploy" | "delete_resource";
export const cloudflareClient = {
  manage(id: number, action: CloudflareAction, input: Record<string, unknown> = {}): Promise<{ items?: Record<string, unknown>[]; success?: boolean; verified?: boolean; mode?: string; name?: string; url?: string; warning?: string; subscriptionUrl?: string; subscriptionPath?: string }> {
    return invokeOrWeb("cloudflare_manage", { id, action, input }, { path: "/api/cloudflare-manage", init: jsonRequest("POST", { id, action, input }) });
  },
};
