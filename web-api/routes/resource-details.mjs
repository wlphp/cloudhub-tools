import { send } from "../core/http.mjs";

export async function handleResourceDetailRoutes(req, res, url, services) {
  const { arr, database, oracleInstanceDisks, ossObjects, rpc, tencent } = services;
    if (req.method === "GET" && url.pathname === "/api/rds-databases") {
      const id = Number(url.searchParams.get("id"));
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const data = await tencent.request(id, "cdb", "2017-03-20", "DescribeDatabases", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || "");
        return send(res, 200, arr(data, ["Items"]).map((item) => ({ ...item, DBName: item.DatabaseName || item.DBName || "" })));
      }
      const data = await rpc(
        id,
        "rds.aliyuncs.com",
        "2014-08-15",
        "DescribeDatabases",
        {
          RegionId: url.searchParams.get("region") || "",
          DBInstanceId: url.searchParams.get("instance") || "",
        },
      );
      return send(res, 200, arr(data, ["Databases", "Database"]));
    }
    if (req.method === "GET" && url.pathname === "/api/rds-accounts") {
      const id = Number(url.searchParams.get("id"));
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const data = await tencent.request(id, "cdb", "2017-03-20", "DescribeAccounts", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || "");
        return send(res, 200, arr(data, ["Items"]).map((item) => ({
          ...item,
          AccountName: item.AccountName || item.UserName || "",
          AccountType: item.AccountType || "Normal",
          AccountStatus: item.Status || "Available",
          AccountDescription: item.Description || "",
        })));
      }
      const data = await rpc(
        id,
        "rds.aliyuncs.com",
        "2014-08-15",
        "DescribeAccounts",
        {
          RegionId: url.searchParams.get("region") || "",
          DBInstanceId: url.searchParams.get("instance") || "",
        },
      );
      return send(res, 200, arr(data, ["Accounts", "DBInstanceAccount"]));
    }
    if (req.method === "GET" && url.pathname === "/api/redis-accounts") {
      const id = Number(url.searchParams.get("id"));
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const data = await tencent.request(id, "redis", "2018-04-12", "DescribeInstanceAccount", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || "");
        return send(res, 200, arr(data, ["Accounts"]).map((item) => ({
          ...item,
          AccountName: item.AccountName || item.UserName || "",
          AccountType: item.AccountType || "Normal",
          AccountStatus: item.Status || "Available",
          AccountDescription: item.Description || "",
        })));
      }
      const data = await rpc(
        id,
        "r-kvstore.aliyuncs.com",
        "2015-01-01",
        "DescribeAccounts",
        {
          RegionId: url.searchParams.get("region") || "",
          InstanceId: url.searchParams.get("instance") || "",
        },
      );
      return send(res, 200, arr(data, ["Accounts", "Account"]));
    }
    if (req.method === "GET" && url.pathname === "/api/oss-objects") {
      return send(
        res,
        200,
        await ossObjects(
          Number(url.searchParams.get("id")),
          url.searchParams.get("bucket") || "",
          url.searchParams.get("location") || "",
          {
            prefix: url.searchParams.get("prefix") || "",
            marker: url.searchParams.get("marker") || "",
          },
        ),
      );
    }
    if (req.method === "GET" && url.pathname === "/api/instance-disks") {
      try {
        const id = Number(url.searchParams.get("id"));
        const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
        if (!account) return send(res, 404, { error: "云账号不存在" });
        const item = account.cloud_type === "oracle"
          ? await oracleInstanceDisks(id, url.searchParams.get("region") || "", url.searchParams.get("instance") || "", url.searchParams.get("compartment") || "")
          : account.cloud_type === "tencent"
          ? arr(await tencent.request(id, "cbs", "2017-03-12", "DescribeDisks", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || ""), ["DiskSet"]).map((disk) => ({ ...disk, DiskId: disk.DiskId, DiskName: disk.DiskName || disk.DiskId, Category: disk.DiskType, Size: disk.DiskSize, Status: disk.DiskState }))
          : arr(await rpc(id, `ecs.${url.searchParams.get("region")}.aliyuncs.com`, "2014-05-26", "DescribeDisks", { RegionId: url.searchParams.get("region") || "", InstanceId: url.searchParams.get("instance") || "" }), ["Disks", "Disk"]);
        return send(res, 200, item);
      } catch (error) { return send(res, 200, []); }
    }
  return false;
}
