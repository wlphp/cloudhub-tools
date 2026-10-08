import type { Account, ManagedHost, TransferAccount } from "../../shared/types";
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

export type SyncEnvelope = {
  version: number;
  kdf: string;
  iterations: number;
  salt: string;
  cipher: string;
  nonce: string;
  ciphertext: string;
};
export type SyncAccountPreview = {
  syncId: string;
  accountName: string;
  cloudType: string;
  regionId: string | null;
};
export type SyncManagedHostPreview = Pick<ManagedHost, "name" | "host" | "port" | "username" | "platform"> & { syncId: string; authMethod: string };
export type SyncPanelPreview = { syncId: string; name: string; panelUrl: string; allowInsecureTls: boolean };
export type SyncDeletionPreview = { entityType: "cloud_account" | "managed_host" | "panel_connection"; syncId: string; name: string; willDelete: boolean };
export type SyncDeviceIdentity = { deviceId: string; publicKey: string };
export type SyncDeviceScopeEntry = { entityType: "cloud_account" | "managed_host" | "panel_connection"; entitySyncId: string; displayName: string };
export type SyncTrustedDevice = { deviceId: string; deviceName: string; status: "pending" | "trusted" | "revoked"; publicKeyFingerprint: string; sharedEntities: SyncDeviceScopeEntry[]; approvedAt: number | null; lastSeenAt: number | null };
export type SyncImportConflict = { entityType: "cloudAccount" | "managedHost" | "panel"; syncId: string; name: string; reason: string; resolvable: boolean };
export type SyncImportPreview = { protocolVersion: number; accounts: SyncAccountPreview[]; managedHosts: SyncManagedHostPreview[]; panels: SyncPanelPreview[]; deletions: SyncDeletionPreview[]; conflicts: SyncImportConflict[] };
export type SyncDeltaConflictResolution = { entityType: string; syncId: string; choice: "incoming" | "local" };
export type SyncDeltaConflict = { entityType: string; syncId: string; name: string; reason: string; resolvable: boolean };
export type SyncDeltaReview = { protocolVersion: number; sourceDeviceId: string; targetDeviceId: string; fromSequence: number; throughSequence: number; changeCount: number; conflicts: SyncDeltaConflict[]; deletions: SyncDeletionPreview[] };
export type SyncDeltaApplyResult = { sourceDeviceId: string; receiverDeviceId: string; messageIds: string[]; signature: string; added: number; updated: number; deleted: number };
export type SyncTransferStartResult = { pairingUrl: string; sourceDeviceId: string; sourcePublicKeyFingerprint: string };
export type SyncTransferFetchResult = { sessionId: string; preview: SyncImportPreview; sourceDeviceId: string; sourcePublicKeyFingerprint: string };
export type SyncTransferSelection = { accountSyncIds: string[]; managedHostSyncIds: string[]; panelSyncIds: string[]; includeDeletions: boolean };
export type SyncImportSummary = { accounts: number; managedHosts: number; panels: number; added: number; updated: number; deleted: number };

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

  getSyncDeviceIdentity(): Promise<SyncDeviceIdentity> {
    return nativeOnly("get_sync_device_identity");
  },

  listSyncDevices(): Promise<SyncTrustedDevice[]> {
    return nativeOnly("list_sync_devices");
  },

  setSyncDeviceShareScope(deviceId: string, accountIds: number[], managedHostIds: number[], panelIds: number[], includeDeletions: boolean): Promise<number> {
    return nativeOnly("set_sync_device_share_scope", { deviceId, accountIds, managedHostIds, panelIds, includeDeletions });
  },

  revokeSyncDevice(deviceId: string): Promise<void> {
    return nativeOnly("revoke_sync_device", { deviceId });
  },

  createSyncBundle(accountIds: number[], managedHostIds: number[], panelIds: number[], passphrase: string, includeDeletions: boolean): Promise<SyncEnvelope> {
    return nativeOnly("create_sync_account_bundle", { accountIds, managedHostIds, panelIds, passphrase, includeDeletions });
  },

  createSyncDeltaBundle(targetDeviceId: string, afterSequence: number, limit: number, passphrase: string): Promise<SyncEnvelope> {
    return nativeOnly("create_sync_delta_bundle", { targetDeviceId, afterSequence, limit, passphrase });
  },

  saveSyncDeltaBundleFile(targetDeviceId: string, afterSequence: number, limit: number, passphrase: string): Promise<boolean> {
    return nativeOnly("save_sync_delta_bundle_file", { targetDeviceId, afterSequence, limit, passphrase });
  },

  saveSyncAcknowledgementFile(acknowledgement: SyncDeltaApplyResult): Promise<boolean> {
    return nativeOnly("save_sync_acknowledgement_file", { acknowledgement });
  },

  listPendingSyncAcknowledgements(): Promise<SyncDeltaApplyResult[]> {
    return nativeOnly("list_pending_sync_acknowledgements");
  },

  previewSyncDeltaBundle(envelope: SyncEnvelope, passphrase: string): Promise<SyncDeltaReview> {
    return nativeOnly("preview_sync_delta_bundle", { envelope, passphrase });
  },

  applySyncDeltaBundle(envelope: SyncEnvelope, passphrase: string, resolutions: SyncDeltaConflictResolution[]): Promise<SyncDeltaApplyResult> {
    return nativeOnly("apply_sync_delta_bundle", { envelope, passphrase, resolutions });
  },

  completeSyncDeltaPush(acknowledgement: SyncDeltaApplyResult): Promise<void> {
    return nativeOnly("complete_sync_delta_push", { acknowledgement });
  },

  acknowledgeSyncDelta(peerDeviceId: string, messageIds: string[], signature: string): Promise<number> {
    return nativeOnly("acknowledge_sync_delta", { peerDeviceId, messageIds, signature });
  },

  sendSyncDeltaAckLan(pairingUrl: string, acknowledgement: SyncDeltaApplyResult): Promise<number> {
    return nativeOnly("send_sync_delta_ack_lan", { pairingUrl, acknowledgement });
  },

  startSyncDeltaReceiver(): Promise<SyncTransferStartResult> {
    return nativeOnly("start_sync_delta_receiver", {});
  },

  sendSyncDeltaBundleLan(pairingUrl: string, clientCode: string, passphrase: string, envelope: SyncEnvelope): Promise<number> {
    return nativeOnly("send_sync_delta_bundle_lan", { pairingUrl, clientCode, passphrase, envelope });
  },

  takeReceivedSyncDelta(): Promise<SyncEnvelope | null> {
    return nativeOnly("take_received_sync_delta", {});
  },

  saveSyncBundleFile(accountIds: number[], managedHostIds: number[], panelIds: number[], passphrase: string, includeDeletions: boolean): Promise<boolean> {
    return nativeOnly("save_sync_account_bundle", { accountIds, managedHostIds, panelIds, passphrase, includeDeletions });
  },

  previewSyncBundle(envelope: SyncEnvelope, passphrase: string): Promise<SyncImportPreview> {
    return nativeOnly("preview_sync_account_bundle", { envelope, passphrase });
  },

  importSyncBundle(envelope: SyncEnvelope, passphrase: string): Promise<SyncImportSummary> {
    return nativeOnly("import_sync_account_bundle", { envelope, passphrase });
  },

  startSyncTransfer(accountIds: number[], managedHostIds: number[], panelIds: number[], includeDeletions: boolean): Promise<SyncTransferStartResult> {
    return nativeOnly("start_sync_transfer", { accountIds, managedHostIds, panelIds, includeDeletions });
  },

  startSyncDeltaTransfer(targetDeviceId: string, passphrase: string): Promise<SyncTransferStartResult> {
    return nativeOnly("start_sync_delta_transfer", { targetDeviceId, passphrase });
  },

  cancelSyncTransfer(): Promise<void> {
    return nativeOnly("cancel_sync_transfer");
  },

  approveSyncTransfer(approved: boolean): Promise<void> {
    return nativeOnly("approve_sync_transfer", { approved });
  },

  fetchSyncTransfer(pairingUrl: string, clientCode: string): Promise<SyncTransferFetchResult> {
    return nativeOnly("fetch_sync_transfer", { pairingUrl, clientCode });
  },

  confirmQrSyncImport(sessionId: string, selection: SyncTransferSelection): Promise<SyncImportSummary> {
    return nativeOnly("confirm_sync_transfer_import", { sessionId, selection });
  },

  cancelQrSyncImport(sessionId: string): Promise<void> {
    return nativeOnly("cancel_sync_transfer_import", { sessionId });
  },
};
