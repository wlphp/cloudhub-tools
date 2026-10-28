import { test } from "@playwright/test";
import { transferFixture } from "../transfer-fixture";
test("phone unified migration selects authenticator module", async ({ page }) => {
  await transferFixture(page, "authenticator_entries", "验证器（含种子）", true);
});
