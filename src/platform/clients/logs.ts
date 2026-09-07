import type { ApiLog } from "../../shared/types";
import { invokeOrWeb, queryPath } from "./base";

export type LogKind = "api" | "operation";
export type ApiLogQuery = { keyword?: string; status?: string; limit?: number; offset?: number };

export const logsClient = {
  listApi(query: ApiLogQuery = {}): Promise<ApiLog[]> {
    return invokeOrWeb("list_api_logs", query, { path: queryPath("/api/api-logs", query) });
  },

  clear(kind: LogKind): Promise<void> {
    if (kind === "api") {
      return invokeOrWeb("clear_api_logs", {}, {
        path: "/api/api-logs",
        init: { method: "DELETE" },
      });
    }
    return invokeOrWeb("clear_operation_logs", {}, {
      path: "/api/operation-logs",
      init: { method: "DELETE" },
    });
  },
};
