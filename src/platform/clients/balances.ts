import type { AccountFinance } from "../../features/cloud/finance";
import { invokeOrWeb, jsonRequest } from "./base";

export const balancesClient = {
  list(): Promise<AccountFinance[]> {
    return invokeOrWeb("list_account_balances", {}, {
      path: "/api/account-balances",
    });
  },

  refresh(accountId: number): Promise<AccountFinance> {
    return invokeOrWeb("refresh_account_balance", { id: accountId }, {
      path: "/api/account-balance-refresh",
      init: jsonRequest("POST", { account_id: accountId }),
    });
  },
};
