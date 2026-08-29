import { send } from "../core/http.mjs";

export async function handleOssRoutes(req, res, url, services) {
  const { ossAcl, ossDetail, ossSetPublicRead, ossSetCors, ossCnameMutation } = services;
  const id = Number(url.searchParams.get("id"));
  const bucket = url.searchParams.get("bucket") || "";
  const location = url.searchParams.get("location") || "";

  if (req.method === "GET" && url.pathname === "/api/oss-acl") {
    send(res, 200, { acl: await ossAcl(id, bucket, location) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/oss-detail") {
    send(res, 200, await ossDetail(id, bucket, location));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/oss-public-read") {
    await ossSetPublicRead(id, bucket, location);
    send(res, 200, { ok: true });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/oss-cors") {
    await ossSetCors(id, bucket, location, url.searchParams.get("origins") || "*");
    send(res, 200, { ok: true });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/oss-cname-token") {
    send(res, 200, await ossCnameMutation(id, bucket, location, "token", url.searchParams.get("domain") || ""));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/oss-cname") {
    send(res, 200, await ossCnameMutation(id, bucket, location, "bind", url.searchParams.get("domain") || ""));
    return true;
  }
  if (req.method === "DELETE" && url.pathname === "/api/oss-cname") {
    send(res, 200, await ossCnameMutation(id, bucket, location, "delete", url.searchParams.get("domain") || ""));
    return true;
  }
  return false;
}
