import type { Account, ManagedHost, PanelConnection } from "../../shared/types";
import { UnifiedMigrationPanel } from "./UnifiedMigrationPanel";

type Props = {
  mode: "desktop" | "mobile";
  mobilePage?: boolean;
  accounts?: Account[];
  managedHosts?: ManagedHost[];
  panels?: PanelConnection[];
  onClose?: () => void;
  onImported?: () => void;
};

export function SyncTransferPanel(props: Props) { return <UnifiedMigrationPanel {...props} />; }
