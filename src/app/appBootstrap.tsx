import { lazy } from "react";
import {
  assetFavoriteKey,
  stringListFromValue,
  stringRecordFromValue,
} from "../features/assets/preferences";
import {
  assetTypes as catalogAssetTypes,
  emptyManagedHostDraft,
} from "../features/cloud/catalog";

// Lazy entry points for the seven pages and seven overlay dialogs. Keeping them
// here (instead of inline in App.tsx) means the main bundle stops carrying the
// route component JSX until the user actually navigates to that section.
export const AccountDialog = lazy(() => import("../features/accounts/AccountDialog").then(({ AccountDialog }) => ({ default: AccountDialog })));
export const FavoritesPage = lazy(() => import("../features/assets/FavoritesPage").then(({ FavoritesPage }) => ({ default: FavoritesPage })));
export const AssetsPage = lazy(() => import("../features/assets/AssetsPage").then(({ AssetsPage }) => ({ default: AssetsPage })));
export const AssetDetailDialog = lazy(() => import("../features/assets/AssetDialogs").then(({ AssetDetailDialog }) => ({ default: AssetDetailDialog })));
export const AssetSyncDialog = lazy(() => import("../features/assets/AssetDialogs").then(({ AssetSyncDialog }) => ({ default: AssetSyncDialog })));
export const DomainToolDialog = lazy(() => import("../features/domains/DomainToolDialog").then(({ DomainToolDialog }) => ({ default: DomainToolDialog })));
export const DnsEditorDialog = lazy(() => import("../features/domains/DnsEditorDialog").then(({ DnsEditorDialog }) => ({ default: DnsEditorDialog })));
export const PanelsPage = lazy(() => import("../features/panels/PanelsPage").then(({ PanelsPage }) => ({ default: PanelsPage })));
export const PanelResourceMetrics = lazy(() => import("../features/panels/PanelResourceMetrics").then(({ PanelResourceMetrics }) => ({ default: PanelResourceMetrics })));
export const OperationLogsPage = lazy(() => import("../features/logs/LogsPages").then(({ OperationLogsPage }) => ({ default: OperationLogsPage })));
export const ApiLogsPage = lazy(() => import("../features/logs/LogsPages").then(({ ApiLogsPage }) => ({ default: ApiLogsPage })));
export const SettingsPage = lazy(() => import("../features/settings/SettingsPage").then(({ SettingsPage }) => ({ default: SettingsPage })));
export const ManagedHostDialog = lazy(() => import("../features/servers/ManagedHostDialog").then(({ ManagedHostDialog }) => ({ default: ManagedHostDialog })));
export const TerminalHostSidebar = lazy(() => import("../features/servers/TerminalHostSidebar").then(({ TerminalHostSidebar }) => ({ default: TerminalHostSidebar })));
export const TerminalConnectDialog = lazy(() => import("../features/servers/TerminalConnectDialog").then(({ TerminalConnectDialog }) => ({ default: TerminalConnectDialog })));
export const TerminalWorkspace = lazy(() => import("../features/servers/TerminalWorkspace").then(({ TerminalWorkspace }) => ({ default: TerminalWorkspace })));
export const SshClientDialog = lazy(() => import("../features/servers/SshClientDialog").then(({ SshClientDialog }) => ({ default: SshClientDialog })));
export const ResourceDetailDialog = lazy(() => import("../features/resources/ResourceDetailDialog").then(({ ResourceDetailDialog }) => ({ default: ResourceDetailDialog })));

// Stable localStorage keys so multiple call sites never drift on a typo.
export const cloudHubFavoriteAssetsStorageKey = "cloudhub-tools-favorite-assets";
export const cloudHubFavoriteAssetOrderStorageKey = "cloudhub-tools-favorite-asset-order";
export const cloudHubAssetNotesStorageKey = "cloudhub-tools-asset-notes";
export const cloudHubAssetOrderStorageKey = "cloudhub-tools-asset-order";
export const cloudHubAssetDisplayNamesStorageKey = "cloudhub-tools-asset-display-names";
export const cloudHubTerminalThemeStorageKey = "cloudhub-tools-terminal-theme";

// Re-exported shared singletons. Pages and dialogs read these through here so
// the import surface in App.tsx stays flat.
export { assetFavoriteKey, stringListFromValue, stringRecordFromValue };
export const assetTypes = catalogAssetTypes;
export const emptyManagedHost = emptyManagedHostDraft;

// Bumping this in the same commit as a release is the easiest way to keep the
// status bar honest about which build the user is running.
export const bundledVersion = "0.1.20";
export const isDevelopmentBuild = import.meta.env.DEV;

// Skeleton used by every <Suspense fallback> for lazy pages and dialogs. One
// shared shape keeps the loading feel consistent across the workbench.
export function PageLoadingState() {
  return (
    <section className="page-loading-state" role="status" aria-live="polite" aria-label="正在载入页面">
      <div className="page-loading-header"><span /><strong /></div>
      <div className="page-loading-toolbar"><i /><i /><i /></div>
      <div className="page-loading-table"><span /><span /><span /><span /><span /></div>
    </section>
  );
}
