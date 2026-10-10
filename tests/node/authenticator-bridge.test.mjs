import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { callAuthenticator, closeAuthenticatorBridge } from "../../web-api/services/authenticator.mjs";

test("browser bridge uses real encrypted storage and shared Ente/CloudHub codecs", async () => {
  const id = randomUUID();
  const input = { id: undefined, issuer: "Bridge fixture", account: `fixture-${id}@example.test`, kind: "hotp", algorithm: "SHA1", digits: 6, period: 30, counter: "1729", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", group: "公开测试", note: "temporary test", pinned: false, order: 0 };
  let storedId;
  try {
    const status = await callAuthenticator("status");
    assert.equal(status.unlocked, true);
    await callAuthenticator("save", { input });
    const list = await callAuthenticator("list");
    const stored = list.find(entry => entry.account === input.account);
    assert.ok(stored); storedId = stored.id;
    assert.equal(Object.hasOwn(stored, "secret"), false);
    const codes = await callAuthenticator("codes", { ids: [storedId] });
    assert.match(codes[0].current, /^\d{6}$/);
    assert.equal(codes[0].next, null);
    await callAuthenticator("advance", { id: storedId });
    assert.equal((await callAuthenticator("codes", { ids: [storedId] }))[0].counter, "1730");
    for (const format of ["cloudhub", "ente"]) {
      const exported = await callAuthenticator("export", { ids: [storedId], format, password: "fixture-backup-password", acknowledgePlain: false });
      assert.ok(!exported.content.includes(input.secret));
      const preview = await callAuthenticator("prepare", { text: exported.content, password: "fixture-backup-password" });
      assert.equal(preview.items.length, 1);
      assert.equal(preview.items[0].duplicateId, storedId);
      assert.ok(!JSON.stringify(preview).includes(input.secret));
      assert.deepEqual(await callAuthenticator("import", { token: preview.token, choices: preview.items.map(item => ({ id: item.entry.id, action: "skip" })) }), { added: 0, updated: 0, skipped: 1 });
    }
    await assert.rejects(callAuthenticator("export", { ids: [storedId], format: "plain", password: "", acknowledgePlain: false }));
    await assert.rejects(callAuthenticator("save", { input: { ...input, id: storedId, period: 0 } }));
    await assert.rejects(callAuthenticator("unknown"));
  } finally {
    if (storedId) await callAuthenticator("remove", { ids: [storedId] });
    closeAuthenticatorBridge();
  }
});
