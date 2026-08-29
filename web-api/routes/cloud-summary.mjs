import { send } from "../core/http.mjs";

export async function handleCloudSummaryRoute(req, res, url, services) {
  if (req.method !== "GET" || url.pathname !== "/api/cloud-summary") return false;
  const { database, rpc, arr, cloudResources, tencent, volcResources, ctyunResources } = services;
  const id = Number(url.searchParams.get("id"));
  const accountRow = database().prepare("SELECT access_key_id,cloud_type FROM cloud_accounts WHERE id=?").get(id);
  if (!accountRow) { send(res, 404, { error: "云账号不存在" }); return true; }

  if (accountRow.cloud_type === "tencent") {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 8)}01`;
    const [cvmResult, domainResult, swasResult, rdsResult, redisResult, ossResult, esaResult, identityResult, balanceResult, billResult] = await Promise.allSettled([
      tencent.resources(id, "ecs"), tencent.resources(id, "domain"), tencent.resources(id, "swas"),
      tencent.resources(id, "rds"), tencent.resources(id, "redis"), tencent.resources(id, "oss"), tencent.resources(id, "esa"),
      tencent.request(id, "cam", "2019-01-16", "GetUserAppId"),
      tencent.request(id, "billing", "2018-07-09", "DescribeAccountBalance"),
      tencent.request(id, "billing", "2018-07-09", "DescribeBillSummaryByPayMode", { BeginTime: monthStart, EndTime: today }),
    ]);
    const cvm = cvmResult.status === "fulfilled" ? cvmResult.value.items : [];
    const domains = domainResult.status === "fulfilled" ? domainResult.value.items : [];
    const swas = swasResult.status === "fulfilled" ? swasResult.value.items : [];
    const rds = rdsResult.status === "fulfilled" ? rdsResult.value.items : [];
    const redis = redisResult.status === "fulfilled" ? redisResult.value.items : [];
    const oss = ossResult.status === "fulfilled" ? ossResult.value.items : [];
    const esa = esaResult.status === "fulfilled" ? esaResult.value.items : [];
    const identity = identityResult.status === "fulfilled" ? identityResult.value : {};
    const balance = balanceResult.status === "fulfilled" ? balanceResult.value : {};
    const bill = billResult.status === "fulfilled" ? billResult.value : {};
    const overview = bill.SummaryOverview || bill.SummarySet?.[0] || {};
    const monthlyTotal = tencent.number(overview.RealTotalCost || overview.TotalCost || overview.CashPayAmount);
    send(res, 200, {
      account_id: identity.AppId || identity.UserAppId || accountRow.access_key_id,
      account_type: "腾讯云账号",
      available_amount: tencent.number(balance.Balance || balance.RealBalance) / 100,
      available_cash_amount: tencent.number(balance.CashAccountBalance) / 100,
      credit_amount: tencent.number(balance.PresentAccountBalance || balance.IncentiveAccountBalance || balance.VoucherBalance) / 100,
      month_consume: monthlyTotal, month_bill: monthlyTotal, ecs_count: cvm.length, domain_count: domains.length,
      dns_record_count: domains.reduce((sum, item) => sum + tencent.number(item.RecordCount), 0),
      oss_count: oss.length, rds_count: rds.length, redis_count: redis.length, swas_count: swas.length, esa_count: esa.length,
    });
    return true;
  }

  if (accountRow.cloud_type === "volcengine") {
    const [ecsResult, domainResult, swasResult, ossResult, rdsResult, redisResult, esaResult] = await Promise.allSettled([
      volcResources(id, "ecs"), volcResources(id, "domain"), volcResources(id, "swas"), volcResources(id, "oss"),
      volcResources(id, "rds"), volcResources(id, "redis"), volcResources(id, "esa"),
    ]);
    const itemCount = (result) => result.status === "fulfilled" ? result.value.items.length : 0;
    send(res, 200, {
      account_id: accountRow.access_key_id, account_type: "火山引擎账号", available_amount: 0, available_cash_amount: 0,
      credit_amount: 0, month_consume: 0, month_bill: 0, ecs_count: itemCount(ecsResult), domain_count: itemCount(domainResult),
      dns_record_count: 0, oss_count: itemCount(ossResult), rds_count: itemCount(rdsResult), redis_count: itemCount(redisResult),
      swas_count: itemCount(swasResult), esa_count: itemCount(esaResult),
    });
    return true;
  }

  if (accountRow.cloud_type === "ctyun") {
    const [ecs, domains, rds, redis, oss] = await Promise.all(["ecs", "domain", "rds", "redis", "oss"].map((type) => ctyunResources(id, type)));
    send(res, 200, {
      account_id: accountRow.access_key_id, account_type: "天翼云账号", available_amount: 0, available_cash_amount: 0,
      credit_amount: 0, month_consume: 0, month_bill: 0, ecs_count: ecs.items.length, domain_count: domains.items.length,
      dns_record_count: domains.items.reduce((sum, item) => sum + Number(item.RecordCount || 0), 0), oss_count: oss.items.length,
      rds_count: rds.items.length, redis_count: redis.items.length, swas_count: 0, esa_count: 0,
    });
    return true;
  }

  const [domainData, accountData, balanceData, billData] = await Promise.allSettled([
    rpc(id, "domain.aliyuncs.com", "2018-01-29", "QueryDomainList", { PageNum: "1", PageSize: "100" }),
    rpc(id, "bss.openapi.aliyuncs.com", "2017-12-14", "QueryAccountInfo", {}),
    rpc(id, "bss.openapi.aliyuncs.com", "2017-12-14", "QueryAccountBalance", {}),
    rpc(id, "bss.openapi.aliyuncs.com", "2017-12-14", "QueryBillOverview", { BillingCycle: new Date().toISOString().slice(0, 7) }),
  ]);
  const domains = domainData.status === "fulfilled" ? arr(domainData.value, ["Data", "Domain"]) : [];
  const resourceTypes = ["ecs", "oss", "rds", "redis", "swas", "esa"];
  const results = await Promise.allSettled(resourceTypes.map((type) => cloudResources(id, type)));
  const counts = Object.fromEntries(resourceTypes.map((type, index) => [type, results[index].status === "fulfilled" ? results[index].value.items.length : 0]));
  const accountInfo = accountData.status === "fulfilled" ? accountData.value.Data || {} : {};
  const balanceInfo = balanceData.status === "fulfilled" ? balanceData.value.Data || {} : {};
  const billInfo = billData.status === "fulfilled" ? billData.value.Data || {} : {};
  send(res, 200, {
    account_id: accountInfo.AccountId || accountRow.access_key_id || "-",
    account_type: accountInfo.AccountType === "1" ? "主账号" : accountInfo.AccountType === "2" ? "子账号" : "-",
    available_amount: Number(balanceInfo.AvailableAmount || 0), available_cash_amount: Number(balanceInfo.AvailableCashAmount || 0),
    credit_amount: Number(balanceInfo.CreditAmount || 0), month_consume: Number(billInfo.PretaxAmount || 0), month_bill: Number(billInfo.PretaxAmount || 0),
    ecs_count: counts.ecs, domain_count: domains.length, dns_record_count: domains.reduce((sum, domain) => sum + Number(domain.RecordCount || 0), 0),
    oss_count: counts.oss, rds_count: counts.rds, redis_count: counts.redis, swas_count: counts.swas, esa_count: counts.esa,
  });
  return true;
}
