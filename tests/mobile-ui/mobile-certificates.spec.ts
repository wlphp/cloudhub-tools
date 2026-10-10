import { expect, test } from "@playwright/test";
import { certificateHealth } from "../../src/mobile/certificate-health";
import type { CertificateSummary } from "../../src/platform/clients/certificates";

const now = Date.now();
const day = 86400;
const base: CertificateSummary = { id: 1, syncId: "fixture", provider: "letsencrypt", primaryDomain: "example.com", domains: ["example.com", "*.example.com"], status: "issued", issuer: "Let's Encrypt", notBefore: Math.floor(now/1000)-day, notAfter: Math.floor(now/1000)+80*day, updatedAt: now };

test("expiry boundaries distinguish expired, expiring, not yet valid and missing dates", () => {
  const sec = Math.floor(now/1000);
  expect(certificateHealth({...base,notAfter: sec},now).key).toBe("expired");
  expect(certificateHealth({...base,notAfter: sec+30*day},sec*1000).key).toBe("expiring");
  expect(certificateHealth({...base,notAfter: sec+30*day+1},sec*1000).key).toBe("valid");
  expect(certificateHealth({...base,notAfter: null},now).key).toBe("unknown");
  expect(certificateHealth({...base,notBefore: sec+day},now).label).toBe("尚未生效");
  expect(certificateHealth({...base,status:"revoked"},now).label).toBe("已吊销");
});

for (const width of [375,768,1024,1440]) test(`certificate summaries work in browser without accounts at ${width}px`, async ({ page }) => {
  await page.setViewportSize({width,height:900});
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path === "/api/certificate-summaries" ? [base,{...base,id:-2,syncId:"second",primaryDomain:"renew.example.com",notAfter:Math.floor(now/1000)+12*day},{...base,id:-3,syncId:"third",primaryDomain:"old.example.com",notAfter:Math.floor(now/1000)-2*day}] : [];
    await route.fulfill({json:data});
  });
  await page.goto("/");
  await page.locator(".mobile-tab-bar").getByRole("button",{name:"更多",exact:true}).click();
  await page.locator(".mobile-more-feature").filter({hasText:"证书管理"}).click();
  await expect(page.locator(".mobile-cert-card")).toHaveCount(3);
  await expect(page.locator(".mobile-notice")).toHaveCount(0);
  await page.getByRole("button",{name:"即将到期"}).click();
  await expect(page.locator(".mobile-cert-card")).toHaveCount(1);
  await expect(page.locator(".mobile-cert-card h3")).toHaveText("renew.example.com");
  await page.getByRole("button",{name:"全部证书"}).click();
  await page.locator(".mobile-cert-card").filter({hasText:"example.com"}).last().locator("summary").click();
  await expect(page.getByText("*.example.com",{exact:false}).last()).toBeVisible();
  for (const region of [".mobile-content",".mobile-certificates"]) expect(await page.locator(region).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  if (width === 375) await page.screenshot({path:"test-results/mobile-certificates.png"});
  await page.getByRole("textbox",{name:"搜索证书域名或签发者"}).fill("missing");
  await expect(page.getByText("没有匹配的证书")).toBeVisible();
  await page.getByRole("button",{name:"清除筛选"}).click();
  await expect(page.locator(".mobile-cert-card")).toHaveCount(3);
});
