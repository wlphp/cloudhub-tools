import { nativeOnly, invokeOrWeb } from "./base";
import type { Certificate } from "../../shared/types";

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
