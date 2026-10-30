import { chromium } from "playwright";

const baseURL = process.env.CLOUDHUB_PREVIEW_URL ?? "http://127.0.0.1:4174";
const account = {
  id: 12,
  account_name: "生产环境",
  cloud_type: "aliyun",
  enabled: true,
  sort_order: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};
const assets = [
  { account_id: 12, resource_type: "ecs", asset_key: "i-demo-001", region_id: "cn-hangzhou", payload: { instanceId: "i-demo-001", instanceName: "web-prod-01", status: "Running", instanceType: "ecs.g7.large", publicIpAddress: { ipAddress: ["203.0.113.10"] } }, fetched_at: 1_700_000_000 },
  { account_id: 12, resource_type: "ecs", asset_key: "i-demo-002", region_id: "cn-shanghai", payload: { instanceId: "i-demo-002", instanceName: "api-prod-01", status: "Running", instanceType: "ecs.c7.large", publicIpAddress: { ipAddress: ["203.0.113.20"] } }, fetched_at: 1_700_000_000 },
  { account_id: 12, resource_type: "domain", asset_key: "example.com", region_id: "cn-hangzhou", payload: { DomainName: "example.com", ExpirationDate: "2027-12-31" }, fetched_at: 1_700_000_000 },
  { account_id: 12, resource_type: "domain", asset_key: "cloudhub.example", region_id: "cn-shanghai", payload: { DomainName: "cloudhub.example", ExpirationDate: "2027-10-18" }, fetched_at: 1_700_000_000 },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.route("**/api/**", route => route.fulfill({ json: [] }));
await page.route("**/api/accounts**", route => route.fulfill({ json: [account] }));
await page.route("**/api/local-assets**", route => {
  const resourceType = new URL(route.request().url()).searchParams.get("resource_type");
  return route.fulfill({ json: assets.filter(item => !resourceType || item.resource_type === resourceType) });
});
await page.goto(baseURL, { waitUntil: "networkidle" });
await page.screenshot({ path: "docs/screenshots/mobile-accounts.png", fullPage: true });
await page.getByRole("button", { name: "服务器", exact: true }).click();
await page.getByRole("heading", { name: "云服务器", exact: true }).waitFor();
await page.screenshot({ path: "docs/screenshots/mobile-servers.png", fullPage: true });
await page.getByRole("button", { name: "域名" }).click();
await page.getByRole("heading", { name: "域名与 DNS", exact: true }).waitFor();
await page.screenshot({ path: "docs/screenshots/mobile-domains.png", fullPage: true });
await browser.close();
