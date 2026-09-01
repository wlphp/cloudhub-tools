export function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(payload);
}

export function sendError(res, status, code, message, details = undefined) {
  const body = { error: message, code };
  if (details) body.details = details;
  send(res, status, body);
}

export function sendUnsupportedInPreview(res, feature, hint = "请在桌面端运行 CloudHub Tools") {
  sendError(res, 501, "unsupported-in-preview", `${feature} 仅在桌面端可用`, { feature, hint });
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onData = (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_BODY_BYTES) {
        const error = new Error("请求过大");
        error.statusCode = 413;
        req.off("data", onData);
        req.resume();
        fail(error);
        return;
      }
      chunks.push(buffer);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("请求已中止")));
  });
}
