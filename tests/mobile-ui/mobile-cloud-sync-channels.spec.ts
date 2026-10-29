import { test } from "@playwright/test";
import { verifyCloudChannels } from "../cloud-sync-channels.scenario";

test("mobile manages independent cloud channels and scopes every operation", async ({ page }) => {
  await verifyCloudChannels(page, true);
});
