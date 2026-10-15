import { expect, test } from "@playwright/test";

test("电脑信息面板支持单独复制 Wi-Fi 密码，并可打开和关闭摄像头预览", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { computerInfoCopy: "", computerInfoExport: "", cameraStopped: false, hardwareInfoCalls: 0, __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command: string, args: any) => {
        if (command === "hardware_info_get") {
          const call = ++(window as any).hardwareInfoCalls;
          return {
          model: "Example Laptop", os: "Windows 11 专业版", uptime: `1 天 ${call} 小时`,
          updatedAt: "2026-10-15 12:00:00", wifiPasswordSupported: true,
          sections: [
            { title: "处理器与主板", rows: [{ label: "处理器", value: `Example CPU ${call}` }, { label: "主板", value: "Example Board" }] },
            { title: "内存与显卡", rows: [{ label: "内存", value: "32 GB" }, { label: "显卡", value: "Example GPU" }] },
            { title: "显示与存储", rows: [{ label: "显示器", value: "Example Display" }, { label: "磁盘", value: "Example Disk" }] },
            { title: "网络与代理", rows: [{ label: "网卡", value: "Example Wi-Fi" }, { label: "当前 Wi-Fi", value: `Example SSID ${call}` }, { label: "默认网关", value: "192.168.1.1" }, { label: "系统代理", value: "手动代理未启用" }] },
            { title: "音频、摄像头与电源", rows: [{ label: "声卡", value: "Example Audio" }, { label: "摄像头", value: "Example Camera" }, { label: "电池", value: "100%，已充满" }] },
          ],
          };
        }
        if (command === "hardware_wifi_password_reveal") return { ssid: "Example SSID", password: "test-only-secret" };
        if (command === "hardware_info_export_png") { (window as any).computerInfoExport = args.dataUrl; return null; }
        if (command === "authenticator_status") return { configured: false, unlocked: false };
        if (command === "plugin:updater|check") return null;
        return [];
      },
    } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).computerInfoCopy = value; } } });
    const track = { stop: () => { (window as any).cameraStopped = true; } };
    const stream = new MediaStream();
    Object.defineProperty(stream, "getTracks", { value: () => [track] });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => stream } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "软件商店", exact: true }).first().click();
  const row = page.locator(".software-store-page tr").filter({ hasText: "电脑信息" });
  await row.getByRole("button", { name: "查看", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "电脑信息" });
  await expect(dialog.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("Example Laptop")).toBeVisible();
  const dialogBounds = await dialog.boundingBox();
  expect(dialogBounds!.width).toBeGreaterThan(1100);
  expect(dialogBounds!.height).toBeGreaterThan(620);
  await expect(dialog.getByText("电脑信息会缓存在本设备本地；打开面板先显示缓存", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).hardwareInfoCalls)).toBe(1);

  await dialog.getByRole("tab", { name: "网络" }).click();
  await expect(dialog.getByRole("tabpanel").getByText("192.168.1.1")).toBeVisible();
  await dialog.screenshot({ path: "test-results/computer-info-network.png" });
  await dialog.getByRole("button", { name: "显示密码" }).click();
  const wifiDialog = page.getByRole("dialog", { name: "Example SSID 属性" });
  await expect(wifiDialog.getByText("test-only-secret")).toBeVisible();
  await expect(wifiDialog.locator(".wifi-password-qr svg")).toBeVisible();
  await wifiDialog.screenshot({ path: "test-results/wifi-password-dialog.png" });
  await page.locator(".wifi-password-backdrop").click({ position: { x: 4, y: 4 } });
  await expect(wifiDialog).toBeVisible();
  await wifiDialog.getByRole("button", { name: "复制密码" }).click();
  expect(await page.evaluate(() => (window as any).computerInfoCopy)).toBe("test-only-secret");
  await expect(wifiDialog.getByRole("status")).toHaveText("密码已复制到剪贴板");
  await wifiDialog.getByRole("button", { name: "关闭 Wi-Fi 密码" }).click();
  await expect(wifiDialog).toHaveCount(0);
  await dialog.getByRole("button", { name: "复制信息" }).click();
  expect(await page.evaluate(() => (window as any).computerInfoCopy)).not.toContain("test-only-secret");
  await dialog.getByRole("button", { name: "导出图片" }).click();
  const exportedText = await page.evaluate(() => atob(((window as any).computerInfoExport as string).split(",")[1]));
  expect(exportedText).not.toContain("test-only-secret");

  const cachedInfo = await page.evaluate(() => localStorage.getItem("cloudhub-computer-info-cache-v1") || "");
  expect(cachedInfo).toContain("Example Laptop");
  expect(cachedInfo).toContain("Example SSID 1");
  expect(cachedInfo).toContain("192.168.1.1");
  expect(cachedInfo).toContain("手动代理未启用");
  expect(cachedInfo).not.toContain("test-only-secret");

  await dialog.getByRole("button", { name: "关闭电脑信息" }).click();
  await expect(dialog).toHaveCount(0);
  await row.getByRole("button", { name: "查看", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).hardwareInfoCalls)).toBe(2);
  await dialog.getByRole("tab", { name: "网络" }).click();
  await expect(dialog.getByText("Example SSID 2")).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "硬件" })).toBeVisible();
  await dialog.getByRole("tab", { name: "硬件" }).click();
  await expect(dialog.getByText("Example CPU 1")).toBeVisible();
  await dialog.getByRole("button", { name: "刷新电脑信息" }).click();
  await expect(dialog.getByText("Example CPU 3")).toBeVisible();
  await dialog.getByRole("tab", { name: "网络" }).click();
  await expect(dialog.getByText("Example SSID 3")).toBeVisible();
  expect(await page.evaluate(() => (window as any).hardwareInfoCalls)).toBe(3);

  await page.locator(".hardware-info-backdrop").click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "设备与电源" }).focus();
  await page.keyboard.press("End");
  await expect(dialog.getByRole("tab", { name: "设备与电源" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("摄像头预览")).toBeVisible();
  expect(await dialog.locator(".hardware-info-body").evaluate(element => getComputedStyle(element).overflowX)).toBe("hidden");
  await expect(dialog.getByText("默认网关")).toHaveCount(0);
  await dialog.getByRole("button", { name: "打开摄像头" }).click();
  const cameraDialog = page.getByRole("dialog", { name: "摄像头实时预览" });
  await expect(cameraDialog).toBeVisible();
  await expect(cameraDialog).toHaveClass(/modal-form-layout/);
  await expect(cameraDialog).toHaveClass(/dialog-common-theme/);
  await expect(cameraDialog.locator(":scope > .modal-head")).toBeVisible();
  await expect(cameraDialog.locator(":scope > .modal-head")).not.toContainText("拖动标题栏移动");
  await expect(cameraDialog.locator(":scope > .modal-head")).not.toHaveAttribute("title", /./);
  await expect(cameraDialog.locator(":scope > .modal-body")).toBeVisible();
  await expect(cameraDialog.locator(":scope > .modal-actions")).toBeVisible();
  await expect(cameraDialog.getByRole("button", { name: "关闭预览", exact: true })).toHaveClass(/secondary/);
  await page.locator(".computer-camera-backdrop").click({ position: { x: 4, y: 4 } });
  await expect(cameraDialog).toBeVisible();
  const cameraHeader = cameraDialog.locator(":scope > header");
  const beforeDrag = await cameraDialog.boundingBox();
  const headerBox = await cameraHeader.boundingBox();
  expect(beforeDrag).not.toBeNull();
  expect(headerBox).not.toBeNull();
  await page.mouse.move(headerBox!.x + headerBox!.width / 2, headerBox!.y + headerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(headerBox!.x + headerBox!.width / 2 + 72, headerBox!.y + headerBox!.height / 2 + 44);
  await page.mouse.up();
  const afterDrag = await cameraDialog.boundingBox();
  expect(afterDrag).not.toBeNull();
  expect(afterDrag!.x).toBeGreaterThan(beforeDrag!.x + 40);
  expect(afterDrag!.x).toBeGreaterThanOrEqual(0);
  expect(afterDrag!.y).toBeGreaterThanOrEqual(0);
  expect(afterDrag!.x + afterDrag!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  expect(afterDrag!.y + afterDrag!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  await cameraDialog.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(cameraDialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).cameraStopped)).toBe(true);
});
