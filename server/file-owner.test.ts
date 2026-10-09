import { describe, expect, it } from "vitest";
import { fileOwner } from "./storage";

/** /files serves a file only to the workspace (or person) it belongs to; a path that belongs to no one is never served. */
describe("who a stored file belongs to", () => {
  it("reads the workspace or the person from the path, and nothing else", () => {
    expect(fileOwner("/org-12/documents/w9_ab12.pdf")).toEqual({ kind: "org", id: 12 });
    expect(fileOwner("/org-3/work/a%20b_cd.png")).toEqual({ kind: "org", id: 3 });
    expect(fileOwner("/user-7/photo/image_ab.png")).toEqual({ kind: "user", id: 7 });
    expect(fileOwner("/images/image_ab.png")).toBeNull();
    expect(fileOwner("/cache/leie.csv")).toBeNull();
    expect(fileOwner("/org-12/../org-13/documents/x.pdf")).toBeNull();
    expect(fileOwner("/org-12/%2e%2e/org-13/x.pdf")).toBeNull();
    expect(fileOwner("/org-x/documents/x.pdf")).toBeNull();
    expect(fileOwner("/%E0%A4%A")).toBeNull();
  });
});
