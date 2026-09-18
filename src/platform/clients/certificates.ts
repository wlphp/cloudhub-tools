import { nativeOnly } from "./base";
import type { Certificate } from "../../shared/types";

export type CertificateRequest = {
  accountId: number;
  provider: "letsencrypt" | "litessl";
  primaryDomain: string;
  domains: string[];
  dnsZone: string;
  eabKid?: string;
  eabHmacKey?: string;
  operationId?: string;
};

export const certificatesClient = {
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
