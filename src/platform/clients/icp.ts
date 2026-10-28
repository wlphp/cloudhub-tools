import { nativeOnly } from "./base";

export type IcpResult = {
  target: string; registered: boolean; checkedAt: number | null;
  company_beian_code?: string; company_name?: string; domain?: string; name?: string;
  site_beian_code?: string; type?: string; update_time?: string; verify_time?: string; website_index?: string;
};
export const icpClient = { query: (domain: string) => nativeOnly<IcpResult>("query_domain_icp", { domain }) };
