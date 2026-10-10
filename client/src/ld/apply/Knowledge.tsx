import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs } from "../ui";
import { fmtDate, uploadFile } from "../meta";

const FOLDERS: Record<string, string[]> = {
  grants: ["Past applications", "Boilerplate", "Budgets", "Attachments", "RFPs", "Reviewer comments", "Answers"],
  speaking: ["Talks and bios", "Past proposals", "Attachments", "Answers"],
  default: ["Examples", "Notes", "Attachments"],
};

const COLS = "minmax(0,2.4fr) 110px minmax(0,1.3fr) 120px 128px";
const KIND_LABEL: Record<string, string> = { fact: "Text", webpage: "Link", document: "File", image: "Image" };

function readLabel(k: { kind: string; pages: number | null; pagesUnit: string | null; chars: number | null; readNote: string | null; sourceUrl: string | null }) {
  if (k.kind === "webpage") return k.sourceUrl?.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") ?? "Webpage";
  if (!k.pages) return k.chars ? `${k.chars.toLocaleString("en-US")} characters` : "";
  const unit = k.pagesUnit === "words" ? "words" : k.pagesUnit === "sheets" ? (k.pages === 1 ? "sheet" : "sheets") : k.pagesUnit === "slides" ? (k.pages === 1 ? "slide" : "slides") : k.pages === 1 ? "page" : "pages";
  if (k.pagesUnit === "words") return `${k.pages.toLocaleString("en-US")} words`;
  return `All ${k.pages} ${unit}${k.readNote === "from the image" ? ", from the image" : ""}`;
}

function fileKindLabel(name: string | null | undefined, kind: string) {
  if (kind !== "document" || !name) return KIND_LABEL[kind] ?? "Text";
  const ext = name.toLowerCase().split(".").pop();
  return ext === "pdf" ? "PDF" : ext === "docx" ? "Word" : ext === "xlsx" ? "Excel" : ext === "pptx" ? "PowerPoint" : "File";
}

/** One employee's own Knowledge: files, links and text only this employee reads. */
export default function Knowledge({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const allFolders = FOLDERS[emp.kind] ?? FOLDERS.default;
  const q = trpc.employeeKnowledge.list.useQuery({ organizationId: currentOrgId, employeeId: emp.id });
  // Folders the employee fills in itself show only once they have something in them.
  const folders = allFolders.filter((f) => !["Reviewer comments", "Answers"].includes(f) || (q.data ?? []).some((i) => i.folder === f));
  const [tab, setTab] = React.useState<string>("all");
  const [adding, setAdding] = React.useState(false);
  const [open, setOpen] = React.useState<number | null>(null);
  const items = q.data ?? [];
  const shown = tab === "all" ? items : items.filter((i) => (i.folder ?? folders[0]) === tab);

  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      <div className="ld-row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="ld-btn p" onClick={() => setAdding(true)}>Add</button>
      </div>
      <FolderTabs
        value={tab}
        onChange={(k) => { setTab(k); setOpen(null); }}
        tabs={[{ key: "all", label: `All (${items.length})` }, ...folders.map((f) => ({ key: f, label: `${f} (${items.filter((i) => (i.folder ?? folders[0]) === f).length})` }))]}
      >
        {adding && <AddPanel emp={emp} folders={folders.filter((f) => f !== "Answers")} start={tab === "all" ? folders[0] : tab} onDone={() => setAdding(false)} />}
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Item</span>
          <span>Kind</span>
          <span>Read</span>
          <span>Added</span>
          <span />
        </div>
        {shown.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : `Nothing here yet. Add past applications, boilerplate and anything ${emp.name} should read.`}</div>}
        {shown.map((k) => {
          const isOpen = open === k.id;
          return (
            <React.Fragment key={k.id}>
              <div
                className={`ld-rw ${isOpen ? "open" : ""}`}
                style={{ gridTemplateColumns: COLS, cursor: "pointer" }}
                aria-expanded={isOpen}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("button,a,input,select")) return;
                  setOpen(isOpen ? null : k.id);
                }}
              >
                <span className="ld-strong">{k.title}</span>
                <span>{fileKindLabel(k.fileUrl, k.kind)}</span>
                <span className="ld-clip" style={{ whiteSpace: "nowrap" }}>{readLabel(k)}</span>
                <span>{fmtDate(k.createdAt)}</span>
                {k.fileUrl || k.sourceUrl ? (
                  <a href={(k.fileUrl || k.sourceUrl)!} target="_blank" rel="noreferrer noopener" className="ld-btn">Open</a>
                ) : (
                  <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : k.id)}>Open</button>
                )}
              </div>
              {isOpen && <Expand item={k} folders={folders} />}
            </React.Fragment>
          );
        })}
      </FolderTabs>
    </main>
  );
}

function Expand({ item, folders }: { item: { id: number; title: string; folder: string | null; content: string; kind: string; sections: string[]; usedIn: string[] }; folders: string[] }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState(item.title);
  const [folder, setFolder] = React.useState(item.folder ?? folders[0]);
  const save = trpc.employeeKnowledge.update.useMutation({ onSuccess: async () => { setEditing(false); await utils.employeeKnowledge.list.invalidate(); } });
  const remove = trpc.employeeKnowledge.remove.useMutation({ onSuccess: () => utils.employeeKnowledge.list.invalidate() });
  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      {editing ? (
        <div style={{ gridColumn: "span 2", display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor={`kt-${item.id}`}>Title</label>
            <input id={`kt-${item.id}`} className="ld-in" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor={`kf-${item.id}`}>Folder</label>
            <select id={`kf-${item.id}`} className="ld-in" value={folder} onChange={(e) => setFolder(e.target.value)}>
              {folders.map((f) => <option key={f}>{f}</option>)}
            </select>
          </div>
          <ErrorLine error={save.error} />
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="ld-lbl">{item.sections.length ? "Sections found" : "What it says"}</span>
            <span className="ld-body" style={{ overflowWrap: "anywhere" }}>{item.sections.length ? item.sections.join(", ") : item.content.slice(0, 300) + (item.content.length > 300 ? "..." : "")}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="ld-lbl">Used in</span><span className="ld-body">{item.usedIn.length ? item.usedIn.join(", ") : "Not used yet"}</span></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="ld-lbl">Folder</span><span className="ld-body">{item.folder ?? folders[0]}</span></div>
          </div>
        </>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {editing ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: item.id, title, folder })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className="ld-btn danger" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: item.id })}>Remove</button>
          </>
        )}
      </div>
    </div>
  );
}

function AddPanel({ emp, folders, start, onDone }: { emp: EmployeeRow; folders: string[]; start: string; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [mode, setMode] = React.useState<"file" | "link" | "text">("file");
  const [file, setFile] = React.useState<File | null>(null);
  const [url, setUrl] = React.useState("");
  const [text, setText] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [folder, setFolder] = React.useState(start);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const addLink = trpc.employeeKnowledge.addLink.useMutation();
  const addText = trpc.employeeKnowledge.addText.useMutation();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const seg = (on: boolean, lastOne = false): React.CSSProperties => ({ height: 34, padding: "0 16px", border: 0, borderRight: lastOne ? 0 : "1px solid #cfd9d4", background: on ? "var(--ld-accent-bg)" : "#fff", color: on ? "var(--ld-accent-dark)" : "var(--ld-text2)", font: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" });

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === "file") {
        if (!file) throw new Error("Choose a file.");
        await uploadFile("knowledge", file, { organizationId: currentOrgId, employeeId: emp.id, folder, title: title.trim() || file.name.replace(/\.[^.]+$/, "") });
      } else if (mode === "link") {
        await addLink.mutateAsync({ organizationId: currentOrgId, employeeId: emp.id, url: url.trim(), title: title.trim() || undefined, folder });
      } else {
        await addText.mutateAsync({ organizationId: currentOrgId, employeeId: emp.id, title: title.trim(), folder, content: text });
      }
      await utils.employeeKnowledge.list.invalidate();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: "var(--ld-hover)", padding: "16px 18px", borderBottom: "1px solid #e3e9e6", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <span className="ld-st">Add to {emp.name}'s knowledge</span>
        <div role="group" aria-label="What you are adding" style={{ display: "flex", border: "1px solid #cfd9d4", borderRadius: 8, overflow: "hidden", width: "max-content" }}>
          <button type="button" style={seg(mode === "file")} onClick={() => setMode("file")}>File</button>
          <button type="button" style={seg(mode === "link")} onClick={() => setMode("link")}>Link</button>
          <button type="button" style={seg(mode === "text", true)} onClick={() => setMode("text")}>Text</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) minmax(0,1fr)", gap: 12, alignItems: "end" }}>
          {mode === "file" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
              <span className="ld-lbl">File</span>
              <div className="ld-row">
                <input ref={fileRef} id="k-file" type="file" className="ld-sr" accept=".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <button type="button" className="ld-btn" style={{ width: 112, height: 34 }} onClick={() => fileRef.current?.click()}>Choose file</button>
                <span className="ld-small ld-muted ld-clip" style={{ whiteSpace: "nowrap" }}>{file?.name ?? ""}</span>
              </div>
            </div>
          )}
          {mode === "link" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label className="ld-lbl" htmlFor="k-url">Link</label>
              <input id="k-url" className="ld-in lg" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </div>
          )}
          {mode === "text" && <span />}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor="k-title">Title</label>
            <input id="k-title" className="ld-in lg" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor="k-folder">Folder</label>
            <select id="k-folder" className="ld-in lg" value={folder} onChange={(e) => setFolder(e.target.value)}>
              {folders.map((f) => <option key={f}>{f}</option>)}
            </select>
          </div>
        </div>
        {mode === "text" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor="k-text">Text</label>
            <textarea id="k-text" className="ld-ta" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        )}
        <span className="ld-small ld-muted">{mode === "file" ? "PDF (scanned too), Word, Excel, PowerPoint or text" : mode === "link" ? "The page's text is saved" : "Boilerplate, facts, answers you reuse"}</span>
        {error && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>{error}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={busy} onClick={save}>{busy ? "Reading..." : "Save"}</button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
