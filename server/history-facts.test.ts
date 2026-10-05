import { describe, expect, it } from "vitest";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { historyFacts } from "./employees/chat";

describe("employees know whether the Claude history is in the Brain", () => {
  it("says it isn't imported yet, then that it's being read, then that it's in", async () => {
    const { orgId, owner } = await makeWorkspace("history-facts");
    expect(historyFacts(orgId)).toMatch(/has NOT been imported/);
    expect(historyFacts(orgId)).toMatch(/Import history/);
    expect(historyFacts(orgId)).toMatch(/Never run a search instead/);
    const imp = db.createHistoryImport({ organizationId: orgId, userId: owner.id, who: "Ashley Bryant", fileName: "claude.zip", filePath: "/tmp/none.zip", status: "running", total: 400, done: 120 });
    expect(historyFacts(orgId)).toMatch(/being imported into the Brain right now \(120 of 400 chats read\)/);
    db.updateHistoryImport(imp.id, orgId, { status: "done", done: 400 });
    expect(historyFacts(orgId)).toMatch(/has been imported into the Brain/);
    expect(historyFacts(orgId)).not.toMatch(/isn't imported yet/);
  });
});
