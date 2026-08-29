import type { Account, TransferAccount } from "../shared/types";
import { invoke, runningInTauri, webApi } from "./api";

export type AccountSaveInput = Record<string, unknown>;

export async function listAccounts(keyword: string): Promise<Account[]> {
  return runningInTauri
    ? invoke<Account[]>("list_accounts", { keyword: keyword || null })
    : webApi<Account[]>(`/api/accounts?keyword=${encodeURIComponent(keyword)}`);
}

export async function saveAccount(input: AccountSaveInput): Promise<Account> {
  return runningInTauri
    ? invoke<Account>("save_account", { input })
    : webApi<Account>("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
}

export async function deleteAccount(id: number): Promise<void> {
  if (runningInTauri) {
    await invoke("delete_account", { id });
    return;
  }
  await webApi(`/api/accounts?id=${id}`, { method: "DELETE" });
}

export async function revealAccountSecret(id: number): Promise<string> {
  return runningInTauri
    ? invoke<string>("reveal_account_secret", { id })
    : webApi<string>(`/api/account-secret?id=${id}`);
}

export async function verifyAccount(
  id: number,
  cloudType: string,
): Promise<{ region_count: number; default_region: string }> {
  return runningInTauri
    ? invoke<{ region_count: number; default_region: string }>(
        `verify_${cloudType}_account`,
        { id },
      )
    : webApi<{ region_count: number; default_region: string }>(
        "/api/verify-account",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: id }),
        },
      );
}

export async function importAccounts(accounts: TransferAccount[]): Promise<number> {
  if (runningInTauri) return invoke<number>("import_accounts", { accounts });
  return (
    await webApi<{ imported: number }>("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts }),
    })
  ).imported;
}

export type AccountExportResult =
  | { kind: "file"; path: string }
  | { kind: "records"; accounts: TransferAccount[] };

export async function exportAccounts(accountIds: number[]): Promise<AccountExportResult> {
  if (runningInTauri) {
    const path = await invoke<string>("export_accounts_file", {
      accountIds: accountIds.length ? accountIds : null,
    });
    return { kind: "file", path };
  }
  const query = accountIds.length
    ? `?${accountIds.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`
    : "";
  const { accounts } = await webApi<{ accounts: TransferAccount[] }>(`/api/export${query}`);
  return { kind: "records", accounts };
}
