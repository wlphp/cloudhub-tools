import { invokeOrWeb, jsonRequest } from "./base";

export type IpLocationResult = {
  feature: "ip";
  target: string;
  found: boolean;
  location?: { country?: string; province?: string; city?: string; isp?: string; display?: string; longitude?: number; latitude?: number; has_coordinates?: boolean } | null;
  checked_at?: number;
  request_id?: string;
  [key: string]: unknown;
};

export const ipLocationClient = {
  query: (ip: string) => invokeOrWeb<IpLocationResult>("query_ip_location", { ip }, { path: "/api/ip-location", init: jsonRequest("POST", { ip }) }),
};
