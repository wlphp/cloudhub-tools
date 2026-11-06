import { chromium } from "playwright";

const url = process.env.TARGET_URL ?? "http://127.0.0.1:1421/";
const width = Number(process.env.WIDTH ?? 619);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
await page.getByRole("heading", { name: "软件商店" }).waitFor();

const read = async (label) => {
  const data = await page.evaluate(() => {
    const row = document.querySelector(".store-table tbody tr");
    const px = (el) => el ? getComputedStyle(el).fontSize : null;
    const desc = el => el && {
      fontSize: getComputedStyle(el).fontSize,
      lineHeight: getComputedStyle(el).lineHeight,
      fontWeight: getComputedStyle(el).fontWeight,
      height: Math.round(el.getBoundingClientRect().height * 100) / 100,
      width: Math.round(el.getBoundingClientRect().width * 100) / 100,
    };
    const cells = {};
    for (const key of ["软件名称", "开发商", "说明", "价格", "平台", "状态", "启用", "首页显示", "操作"]) {
      const td = row.querySelector(`td[data-label="${key}"]`);
      cells[key] = td ? { visible: getComputedStyle(td).display !== "none", before: getComputedStyle(td, "::before").fontSize, fs: px(td) } : null;
    }
    return {
      innerWidth: window.innerWidth,
      dpr: window.devicePixelRatio,
      bodyClass: document.body.className,
      appClass: document.querySelector(".software-store-page")?.className,
      rowClass: row.className,
      strong: desc(row.querySelector(".store-app-name strong")),
      small: desc(row.querySelector(".store-app-name small")),
      toggle: desc(row.querySelector(".store-details-toggle")),
      toggleLabel: row.querySelector(".store-details-toggle")?.textContent,
      description: desc(row.querySelector('[data-label="说明"]')),
      statusChip: desc(row.querySelector(".store-state")),
      rowHeight: Math.round(row.getBoundingClientRect().height * 100) / 100,
      primaryButton: desc([...row.querySelectorAll(".store-row-actions button")].at(-1)),
      cells,
    };
  });
  console.log(label, JSON.stringify(data, null, 1));
  return data;
};

await read("COLLAPSED");
await page.screenshot({ path: `.tmp-${width}-collapsed.png`, fullPage: false });
await page.locator(".store-table tbody tr").first().getByRole("button", { name: "展开详情" }).click();
await page.waitForTimeout(400);
await read("EXPANDED");
await page.screenshot({ path: `.tmp-${width}-expanded.png`, fullPage: false });
await browser.close();
