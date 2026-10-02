import { describe, expect, it } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { decryptJson } from "./_core/crypto";

describe("connection credentials", () => {
  it("encrypts secrets, never returns them, and does not claim a connection it has not verified", async () => {
    const { orgId, owner } = await makeWorkspace("conn");
    const saved = await caller(owner).publishing.updateConnection({
      organizationId: orgId,
      provider: "wordpress",
      accountLabel: "Practice blog",
      accountHandle: "https://example.com/wp-json/wp/v2",
      status: "connected",
      settings: JSON.stringify({ username: "editor", appPassword: "abcd efgh ijkl mnop" }),
    });
    expect(saved?.status).toBe("pending");
    expect(JSON.stringify(saved)).not.toContain("abcd efgh");
    expect(saved?.savedSecrets).toEqual(["appPassword"]);

    const row = await db.getConnectionByProvider(orgId, "wordpress");
    expect(row?.settings).not.toContain("abcd");
    expect(row?.secretsEncrypted).toMatch(/^v1\./);
    expect(decryptJson(row!.secretsEncrypted)).toEqual({ appPassword: "abcd efgh ijkl mnop" });

    // Saving again with the masked value keeps the stored secret.
    await caller(owner).publishing.updateConnection({
      organizationId: orgId,
      provider: "wordpress",
      accountLabel: "Practice blog",
      status: "connected",
      settings: JSON.stringify({ username: "editor", appPassword: "••••••••" }),
    });
    expect(decryptJson((await db.getConnectionByProvider(orgId, "wordpress"))!.secretsEncrypted)).toEqual({ appPassword: "abcd efgh ijkl mnop" });

    // Disconnecting deletes the secrets.
    await caller(owner).publishing.updateConnection({ organizationId: orgId, provider: "wordpress", accountLabel: "Practice blog", status: "disconnected" });
    expect((await db.getConnectionByProvider(orgId, "wordpress"))?.secretsEncrypted).toBeNull();
  });
});
