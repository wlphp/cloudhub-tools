import { test } from "@playwright/test";
import { transferFixture } from "../transfer-fixture";
test("desktop unified migration selects ai module", async ({ page }) => {
  await transferFixture(page, "ai_profiles", "AI 配置", false);
});
