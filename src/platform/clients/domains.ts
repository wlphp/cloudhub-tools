import { invokeOrWeb, jsonRequest, queryPath } from "./base";

export type DomainToolResponse = Record<string, unknown>;

export const domainsClient = {
  whois(accountId: number, domain: string): Promise<string> {
    return invokeOrWeb("query_whois", { id: accountId, domain }, {
      path: queryPath("/api/whois", { id: accountId, domain }),
    });
  },

  records(accountId: number, domain: string, options: { recordType?: string; keyword?: string; page: number; pageSize: number }): Promise<DomainToolResponse> {
    return invokeOrWeb("list_dns_records", {
      id: accountId,
      domain,
      recordType: options.recordType || null,
      keyword: options.keyword || null,
      pageNumber: options.page,
      pageSize: options.pageSize,
    }, {
      path: queryPath("/api/dns-records", {
        id: accountId,
        domain,
        page: options.page,
        pageSize: options.pageSize,
        keyword: options.keyword,
        type: options.recordType,
      }),
    });
  },

  logs(accountId: number, domain: string, keyword: string, page: number, pageSize: number): Promise<DomainToolResponse> {
    return invokeOrWeb("list_domain_logs", {
      id: accountId,
      domain,
      startDate: null,
      endDate: null,
      keyword: keyword || null,
      pageNumber: page,
      pageSize,
    }, {
      path: queryPath("/api/domain-logs", { id: accountId, domain, page, pageSize, keyword }),
    });
  },

  add(accountId: number, domain: string, input: Record<string, unknown>): Promise<DomainToolResponse> {
    return invokeOrWeb("add_dns_record", { id: accountId, domain, ...input }, {
      path: "/api/dns-records",
      init: jsonRequest("POST", { id: accountId, domain, ...input }),
    });
  },

  update(accountId: number, input: Record<string, unknown>): Promise<DomainToolResponse> {
    return invokeOrWeb("update_dns_record", { id: accountId, ...input }, {
      path: "/api/dns-records",
      init: jsonRequest("PUT", { id: accountId, ...input }),
    });
  },

  remove(accountId: number, recordId: string): Promise<DomainToolResponse> {
    return invokeOrWeb("delete_dns_record", { id: accountId, recordId }, {
      path: "/api/dns-records",
      init: jsonRequest("DELETE", { id: accountId, recordId }),
    });
  },

  toggle(accountId: number, recordId: string, status: string): Promise<DomainToolResponse> {
    return invokeOrWeb("toggle_dns_record", { id: accountId, recordId, status }, {
      path: "/api/dns-records",
      init: jsonRequest("PATCH", { id: accountId, recordId, status }),
    });
  },
};
