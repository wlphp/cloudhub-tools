import type { Account, TransferAccount } from "../../shared/types";
import { invokeOrWeb, jsonRequest, nativeOnly, previewOnly, queryPath } from "./base";

export type AccountVerification = { region_count: number; default_region: string };
export type VerifiableCloudType = "vultr" | "ctyun" | "huawei" | "baidu" | "ucloud" | "qiniu" | "aws" | "azure" | "gcp" | "jdcloud" | "qingcloud" | "ksyun";

const verificationCommands: Record<VerifiableCloudType, string> = {
  vultr: "verify_vultr_account",
  ctyun: "verify_ctyun_account",
  huawei: "verify_huawei_account",
  baidu: "verify_baidu_account",
  ucloud: "verify_ucloud_account",
  qiniu: "verify_qiniu_account",
  aws: "verify_aws_account",
  azure: "verify_azure_account",
  gcp: "verify_gcp_account",
  jdcloud: "verify_jdcloud_account",
  qingcloud: "verify_qingcloud_account",
  ksyun: "verify_ksyun_account",
};
const accountExportPath = "/api/export";
export type AccountSaveInput = {
  id?: number;
  account_name: string;
  cloud_type: string;
  access_key_id: string;
  enabled: boolean;
  sort_order: number;
  [key: string]: unknown;
};

export const accountsClient = {
  list(keyword = ""): Promise<Account[]> {
    return invokeOrWeb("list_accounts", { keyword }, { path: queryPath("/api/accounts", { keyword }) });
  },

  save(input: AccountSaveInput): Promise<Account> {
    return invokeOrWeb("save_account", { input }, { path: "/api/accounts", init: jsonRequest("POST", input) });
  },

  verify(cloudType: VerifiableCloudType, accountId: number): Promise<AccountVerification> {
    const command = verificationCommands[cloudType];
    if (!command) throw new Error(`不支持验证云厂商 ${cloudType}`);
    return invokeOrWeb(
      command,
      { id: accountId },
      { path: "/api/verify-account", init: jsonRequest("POST", { account_id: accountId }) },
    );
  },

  remove(id: number): Promise<void> {
    return invokeOrWeb("delete_account", { id }, { path: queryPath("/api/accounts", { id }), init: { method: "DELETE" } });
  },

  exportFile(accountIds: number[] | null): Promise<string> {
    return nativeOnly("export_accounts_file", { accountIds });
  },

  async exportPreview(accountIds: number[]): Promise<TransferAccount[]> {
    const params = new URLSearchParams();
    for (const id of accountIds) params.append("id", String(id));
    const query = params.toString();
    return (await previewOnly<{ accounts: TransferAccount[] }>({ path: `${accountExportPath}${query ? `?${query}` : ""}` })).accounts;
  },

  async import(accounts: TransferAccount[]): Promise<number> {
    const result = await invokeOrWeb<number | { imported: number }>(
      "import_accounts",
      { accounts },
      { path: "/api/import", init: jsonRequest("POST", { accounts }) },
    );
    return typeof result === "number" ? result : result.imported;
  },

  revealSecret(id: number): Promise<string> {
    return invokeOrWeb("reveal_account_secret", { id }, { path: queryPath("/api/account-secret", { id }) });
  },
};
