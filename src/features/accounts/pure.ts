import type { Account } from "../../shared/types";

export type AccountFilterField = "account_name" | "access_key_id";

export function filterAccounts(
  accounts: Account[],
  options: {
    keyword: string;
    field: AccountFilterField;
    group: string;
    status: string;
    cloudType: string;
  },
): Account[] {
  const keyword = options.keyword.trim().toLowerCase();
  return accounts.filter((account) => {
    const source = options.field === "account_name" ? account.account_name : account.access_key_id;
    const matchesKeyword = !keyword || source.toLowerCase().includes(keyword);
    const matchesGroup = !options.group || (account.group_name || "") === options.group;
    const matchesStatus = options.status === "all" || (options.status === "1" ? account.enabled : !account.enabled);
    const matchesCloud = !options.cloudType || account.cloud_type === options.cloudType;
    return matchesKeyword && matchesGroup && matchesStatus && matchesCloud;
  });
}

export function accountGroups(accounts: Account[]): string[] {
  return Array.from(new Set(accounts.map((account) => account.group_name).filter(Boolean) as string[]));
}
