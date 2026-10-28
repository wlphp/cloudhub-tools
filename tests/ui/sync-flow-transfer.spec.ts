import { test } from "@playwright/test";
import { transferFixture } from "../transfer-fixture";
test("desktop unified migration selects flow module", async ({ page }) => {
  await transferFixture(page, "flow_connections", "流水线连接", false);
});
