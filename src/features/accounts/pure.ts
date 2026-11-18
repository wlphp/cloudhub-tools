import type { Account } from "../../shared/types";

export type AccountFilterField = "account_name" | "access_key_id";

export function filterAccounts(
  accounts: Account[],
  options: {
    keyword: string;
    field: AccountFilterField;
    groups: string[];
    statuses: string[];
    cloudTypes: string[];
  },
): Account[] {
  const keyword = options.keyword.trim().toLowerCase();
  return accounts.filter((account) => {
    const source = options.field === "account_name" ? account.account_name : account.access_key_id;
    const matchesKeyword = !keyword || source.toLowerCase().includes(keyword);
    const matchesGroup = options.groups.length === 0 || options.groups.includes(account.group_name || "");
    const matchesStatus = options.statuses.length === 0 || options.statuses.includes(account.enabled ? "1" : "0");
    const matchesCloud = options.cloudTypes.length === 0 || options.cloudTypes.includes(account.cloud_type);
    return matchesKeyword && matchesGroup && matchesStatus && matchesCloud;
  });
}

export function accountGroups(accounts: Account[]): string[] {
  return Array.from(new Set(accounts.map((account) => account.group_name).filter(Boolean) as string[]));
}
