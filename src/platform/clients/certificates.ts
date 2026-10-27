import { nativeOnly, invokeOrWeb } from "./base";
import type { Certificate, PanelConnection } from "../../shared/types";

export type CertificateImportPreview = { token: string; candidates: Array<{ id: string; primaryDomain: string; domains: string[]; issuer: string; serialNumber: string; notBefore: number; notAfter: number; fingerprint: string; warnings: string[] }> };
export type BaotaSiteCertificate = { id: number; panelId: number | null; panelName: string; siteId: number; siteName: string; serverIp?: string | null; panelOrder?: number | null; siteRemark?: string | null; pendingRenewal?: boolean; siteDomains: string[]; certificateDomains: string[]; enabled: boolean; issuer: string | null; notAfter: number | null; fingerprint: string | null; certificateId: number | null; canRenew: boolean; canImport: boolean; capabilityReason: string; checkedAt: number; error: string | null };
export type BaotaCertificateOperation = { renewed: boolean; deployed: boolean; message: string; site: BaotaSiteCertificate };

export type CertificateMetadata = Pick<Certificate, "provider" | "primaryDomain" | "domains" | "status" | "issuer" | "serialNumber" | "notBefore" | "notAfter" | "updatedAt"> & { syncId: string };
export type CertificateSummary = CertificateMetadata & { id: number };

export type CertificateRequest = {
  accountId: number;
  provider: "letsencrypt" | "litessl";
  primaryDomain: string;
  domains: string[];
  dnsZone: string;
  eabKid?: string;
  eabHmacKey?: string;
  operationId?: string;
  esaSiteId?: number;
};

export type EsaCertificateTarget = { accountId: number; siteId: number; siteName: string; accessType: string };
export type EsaCertificateContext = { site: { siteId: number; siteName: string; accessType: string }; candidates: Array<{ id: number; domains: string[]; status: string; deployable: boolean; matchesSite: boolean; reason: string | null; notBefore: number | null; notAfter: number | null }>; remote: Array<{ id: string; name: string; status: string; domains: string[]; notAfter: string; kind: string }> };
export type EsaCertificateDeployment = { remoteId: string; status: string; verified: boolean; message: string };

export const certificatesClient = {
  exportDomains(title: string, domains: string[]): Promise<string | null> { return nativeOnly("export_certificate_domains", { title, domains }); },
  prepareText(certificate: string, privateKey: string): Promise<CertificateImportPreview> { return nativeOnly("prepare_certificate_import_text", { certificate, privateKey }); },
  prepareFiles(paths: string[]): Promise<CertificateImportPreview> { return nativeOnly("prepare_certificate_import_files", { paths }); },
  selectImportFiles(): Promise<CertificateImportPreview | null> { return nativeOnly("select_certificate_import_files"); },
  confirmImport(token: string, candidateId: string): Promise<Certificate> { return nativeOnly("confirm_certificate_import", { token, candidateId }); },
  cancelImport(token: string): Promise<void> { return nativeOnly("cancel_certificate_import", { token }); },
  panels(): Promise<PanelConnection[]> { return nativeOnly("list_panel_connections"); },
  baotaSites(panelId?: number): Promise<BaotaSiteCertificate[]> { return nativeOnly("list_baota_site_certificates", { panelId: panelId ?? null }); },
  syncBaota(panelId: number): Promise<BaotaSiteCertificate[]> { return nativeOnly("sync_baota_site_certificates", { panelId }); },
  removeBaotaDomain(id: number, domain: string): Promise<BaotaSiteCertificate> { return nativeOnly("remove_baota_site_domain", { id, domain }); },
  resolveBaotaDomain(domain: string): Promise<string[]> { return nativeOnly("resolve_baota_site_domain", { domain }); },
  importBaota(id: number): Promise<Certificate> { return nativeOnly("import_baota_site_certificate", { id }); },
  confirmBaotaRetry(id: number): Promise<void> { return nativeOnly("confirm_baota_certificate_retry", { id }); },
  renewBaota(id: number): Promise<BaotaCertificateOperation> { return nativeOnly("renew_baota_site_certificate", { id }); },
  deployBaota(id: number, certificateId: number): Promise<BaotaCertificateOperation> { return nativeOnly("deploy_certificate_to_baota_site", { id, certificateId }); },
  esaContext(accountId: number, siteId: number): Promise<EsaCertificateContext> {
    return nativeOnly("esa_certificate_context", { accountId, siteId });
  },
  deployEsa(accountId: number, siteId: number, certificateId: number): Promise<EsaCertificateDeployment> {
    return nativeOnly("esa_deploy_certificate", { accountId, siteId, certificateId });
  },
  summaries(): Promise<CertificateSummary[]> {
    return invokeOrWeb("list_certificate_summaries", undefined, { path: "/api/certificate-summaries" });
  },
  list(accountId?: number): Promise<Certificate[]> {
    return nativeOnly("list_certificates", { accountId: accountId ?? null });
  },
  request(input: CertificateRequest): Promise<Certificate> {
    return nativeOnly("request_certificate", { input });
  },
  cancel(operationId: string): Promise<void> {
    return nativeOnly("cancel_certificate_request", { operationId });
  },
  material(
    id: number,
  ): Promise<{ certificatePem: string; privateKeyPem: string }> {
    return nativeOnly("get_certificate_material", { id });
  },
  preview(id: number): Promise<{ certificatePem: string; privateKeyAvailable: boolean; chain: Array<{ level: number; name: string; issuer: string; notBefore?: number | null; notAfter?: number | null }> }> {
    return nativeOnly("get_certificate_preview", { id });
  },
  downloadArchive(id: number, primaryDomain: string): Promise<string | null> {
    return nativeOnly("export_certificate_material", { id, primaryDomain });
  },
  remove(id: number): Promise<void> {
    return nativeOnly("delete_certificate", { id });
  },
};
