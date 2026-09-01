import { useCallback, useState } from "react";
import type { Account, ResourceResponse, View } from "../../shared/types";
import { fetchCachedResources, type CachedSummary } from "./cache.ts";

export type ResourceView =
  | "summary"
  | "ecs"
  | "domain"
  | "oss"
  | "rds"
  | "redis"
  | "swas"
  | "esa";

export type { CachedSummary };

export interface UseResourceWorkspaceResult {
  // Resource listing for the detail dialog and the resources page.
  resources: ResourceResponse | null;
  setResources: (next: ResourceResponse | null) => void;

  // Async loader that keeps React state in sync and returns the payload so
  // callers can re-use it without another fetch.
  loadCachedResources: (
    account: Account,
    view: Exclude<ResourceView, "summary">,
  ) => Promise<ResourceResponse>;
}

// useResourceWorkspace owns the resources state that used to live inline in
// src/App.tsx. Callers that still drive loading/status/active transitions can
// keep using their existing helpers; this hook only takes over the resources
// data flow today. The summary state is intentionally left in App.tsx because
// its type comes from two incompatible sources (CachedSummary vs the live
// `cloud_account_summary` payload).
export function useResourceWorkspace(): UseResourceWorkspaceResult {
  const [resources, setResources] = useState<ResourceResponse | null>(null);

  const loadCachedResources = useCallback(
    async (account: Account, view: Exclude<ResourceView, "summary">) => {
      const response = await fetchCachedResources(account, view as Exclude<View, "summary">);
      setResources(response);
      return response;
    },
    [],
  );

  return {
    resources,
    setResources,
    loadCachedResources,
  };
}
