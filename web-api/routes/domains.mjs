import { readBody, send } from "../core/http.mjs";

export async function handleDomainRoutes(req, res, url, services) {
  const { rpc, arr, database, tencent, ctyunRequest, ctyunResources } = services;

  if (req.method === "GET" && url.pathname === "/api/domain-logs") {
    const page = url.searchParams.get("page") || "1";
    const pageSize = url.searchParams.get("pageSize") || "20";
    const data = await rpc(
      Number(url.searchParams.get("id")),
      "alidns.aliyuncs.com",
      "2015-01-09",
      "DescribeRecordLogs",
      {
        DomainName: url.searchParams.get("domain") || "",
        PageNumber: page,
        PageSize: pageSize,
      },
    );
    send(res, 200, { items: arr(data, ["RecordLogs", "RecordLog"]), total: data.TotalCount || 0 });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/whois") {
    const data = await rpc(
      Number(url.searchParams.get("id")),
      "domain.aliyuncs.com",
      "2018-01-29",
      "QueryDomainByDomainName",
      { DomainName: url.searchParams.get("domain") || "" },
    );
    const get = (key) => data[key] ?? "-";
    send(res, 200, `域名信息查询结果\n=====================================\n\n域名: ${get("DomainName")}\n域名持有者: ${get("ZhRegistrantOrganization") || get("RegistrantOrganization")}\n持有者类型: ${get("RegistrantType")}\n联系人: ${get("ZhRegistrantName") || get("RegistrantName")}\n联系邮箱: ${get("Email")}\n\n注册时间: ${get("RegistrationDate")}\n到期时间: ${get("ExpirationDate")}\n注册商: 阿里云\n\n实名认证: ${get("RealNameStatus")}\n域名状态: ${get("DomainStatus")}\nDNS服务器: ${JSON.stringify(get("DnsList"))}`);
    return true;
  }

    if (req.method === "GET" && url.pathname === "/api/dns-records") {
      const type = url.searchParams.get("type") || "";
      const keyword = url.searchParams.get("keyword") || "";
      const page = url.searchParams.get("page") || "1";
      const pageSize = url.searchParams.get("pageSize") || "20";
      const id = Number(url.searchParams.get("id"));
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const limit = Math.min(100, Math.max(1, Number(pageSize) || 20));
        const data = await tencent.request(id, "dnspod", "2021-03-23", "DescribeRecordList", {
          Domain: url.searchParams.get("domain") || "",
          Offset: Math.max(0, (Number(page) - 1) * limit),
          Limit: limit,
          ...(type ? { RecordType: type } : {}),
          ...(keyword ? { Keyword: keyword } : {}),
        });
        const items = arr(data, ["RecordList"]).map((item) => ({
          ...item,
          RecordId: item.RecordId,
          RR: item.Name || "@",
          Type: item.Type,
          Value: item.Value,
          TTL: item.TTL,
          Priority: item.MX || item.Priority,
          Line: item.Line || "默认",
          Status: item.Status,
        }));
        return send(res, 200, { items, total: tencent.number(data.RecordCountInfo?.TotalCount || data.TotalCount) });
      }
      if (account.cloud_type === "ctyun") {
        const region = String(database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(id)?.region_id || "cn-huabei-9");
        const zones = await ctyunResources(id, "domain");
        const zone = zones.items.find((item) => String(item.DomainName || "").toLowerCase() === String(url.searchParams.get("domain") || "").toLowerCase());
        if (!zone?.ZoneId) return send(res, 200, { items: [], total: 0 });
        const data = await ctyunRequest(id, "ctvpc-global.ctapi.ctyun.cn", "GET", "/v4/private-zone-record/list", null, {
          regionID: String(zone._region_id || region), zoneID: String(zone.ZoneId), pageNo: page, pageSize,
          ...(keyword ? { zoneRecordName: keyword } : {}),
        });
        const items = arr(data, ["zoneRecords"]).filter((item) => !type || String(item.type || "").toUpperCase() === type.toUpperCase()).map((item) => ({
          ...item, RecordId: item.zoneRecordID || "", RR: item.name || "@", Type: item.type || "", Value: Array.isArray(item.value) ? item.value.join(", ") : item.value || "", TTL: item.TTL || 0, Priority: "", Line: "默认", Status: "ENABLE",
        }));
        return send(res, 200, { items, total: Number(data.totalCount || items.length) });
      }
      const data = await rpc(
        id,
        "alidns.aliyuncs.com",
        "2015-01-09",
        "DescribeDomainRecords",
        {
          DomainName: url.searchParams.get("domain") || "",
          PageNumber: page,
          PageSize: pageSize,
          ...(type ? { TypeKeyWord: type } : {}),
          ...(keyword ? { RRKeyWord: keyword } : {}),
        },
      );
      return send(res, 200, {
        items: arr(data, ["DomainRecords", "Record"]),
        total: data.TotalCount || 0,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const params = {
        DomainName: payload.domain,
        RR: payload.rr,
        Type: payload.recordType,
        Value: payload.value,
        TTL: payload.ttl || 600,
        ...(payload.line && payload.line !== "default" ? { Line: payload.line } : {}),
      };
      if (payload.recordType === "MX" && payload.priority !== undefined) {
        params.Priority = payload.priority;
      }
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "AddDomainRecord",
        params,
      );
      return send(res, 200, data);
    }
    if (req.method === "PUT" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const params = {
        RecordId: payload.recordId,
        RR: payload.rr,
        Type: payload.recordType,
        Value: payload.value,
        TTL: payload.ttl,
        Line: payload.line,
      };
      if (payload.recordType === "MX" && payload.priority !== undefined) {
        params.Priority = payload.priority;
      }
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "UpdateDomainRecord",
        params,
      );
      return send(res, 200, data);
    }
    if (req.method === "PATCH" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "SetDomainRecordStatus",
        {
          RecordId: payload.recordId,
          Status: payload.status,
        },
      );
      return send(res, 200, data);
    }
    if (req.method === "DELETE" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "DeleteDomainRecord",
        { RecordId: payload.recordId },
      );
      return send(res, 200, data);
    }
  return false;
}
