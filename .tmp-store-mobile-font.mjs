import { chromium } from "playwright";

const url = process.env.TARGET_URL ?? "http://127.0.0.1:1421/";
const width = Number(process.env.WIDTH ?? 390);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await page.goto(url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
await page.getByRole("heading", { name: "软件商店" }).waitFor();

const read = async (label) => {
  const data = await page.evaluate(() => {
    const row = document.querySelector(".store-table tbody tr");
    const desc = el => el && {
      fontSize: getComputedStyle(el).fontSize,
      lineHeight: getComputedStyle(el).lineHeight,
      fontWeight: getComputedStyle(el).fontWeight,
      textSizeAdjust: getComputedStyle(document.documentElement).textSizeAdjust,
      rect: (() => {
        const r = el.getBoundingClientRect();
        return { width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
      })(),
      spanRects: [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => {
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        return { text: n.textContent, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
      }),
    };
    return {
      innerWidth: window.innerWidth,
      dpr: window.devicePixelRatio,
      rowClass: row.className,
      strong: desc(row.querySelector(".store-app-name strong")),
      small: desc(row.querySelector(".store-app-name small")),
      toggle: desc(row.querySelector(".store-details-toggle")),
      toggleLabel: row.querySelector(".store-details-toggle")?.textContent,
      rowHeight: Math.round(row.getBoundingClientRect().height * 100) / 100,
      visibleNames: [...document.querySelectorAll(".store-table tbody tr")].slice(0, 6).map(tr => ({
        name: tr.querySelector(".store-app-name strong")?.textContent,
        strongHeight: Math.round(tr.querySelector(".store-app-name strong")?.getBoundingClientRect().height * 100) / 100,
        rects: [...tr.querySelector(".store-app-name strong").childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => {
          const range = document.createRange();
          range.selectNodeContents(n);
          const r = range.getBoundingClientRect();
          return { height: Math.round(r.height * 100) / 100, width: Math.round(r.width * 100) / 100 };
        }),
      })),
      rowsPerLine: (() => {
        const rows = [...document.querySelectorAll(".store-table tbody tr")].slice(0, 4);
        if (rows.length < 2) return null;
        return Math.abs(rows[0].getBoundingClientRect().top - rows[1].getBoundingClientRect().top) < 5 ? "same-row" : "stacked";
      })(),
    };
  });
  console.log(label, JSON.stringify(data, null, 1));
  return data;
};

await read("COLLAPSED");
const collapsed = await page.evaluate(() => {
  const list = [...document.querySelectorAll(".store-table tbody tr")];
  return {
    rowHeight: Math.round(list[0].getBoundingClientRect().height * 100) / 100,
    names: list.slice(0, 6).map(tr => {
      const s = tr.querySelector(".store-app-name strong");
      return { name: s?.textContent, h: Math.round(s.getBoundingClientRect().height * 100) / 100 };
    }),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  };
});
await page.screenshot({ path: `.tmp-mobile-${width}-collapsed.png`, fullPage: false });
await page.locator(".store-table tbody tr").first().getByRole("button", { name: "展开详情" }).click();
await page.waitForTimeout(500);
await read("EXPANDED");
const expanded = await page.evaluate(() => {
  const list = [...document.querySelectorAll(".store-table tbody tr")];
  return {
    rowHeight: Math.round(list[0].getBoundingClientRect().height * 100) / 100,
    names: list.slice(0, 6).map(tr => {
      const s = tr.querySelector(".store-app-name strong");
      return { name: s?.textContent, h: Math.round(s.getBoundingClientRect().height * 100) / 100 };
    }),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  };
});
await page.screenshot({ path: `.tmp-mobile-${width}-expanded.png`, fullPage: false });
console.log("SUMMARY", JSON.stringify({ width, collapsed, expanded }));
await browser.close();
