import { test } from "@playwright/test";
import { transferFixture } from "../transfer-fixture";
test("desktop unified migration selects certificate module", async ({ page }) => {
  await transferFixture(page, "certificates", "HTTPS 证书与私钥", false);
});
