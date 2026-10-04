import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, FolderTabs, Page } from "../ui";
import { fmtDate } from "../meta";

const CATEGORIES = [
  { value: "mission_profile", label: "Profile and mission" },
  { value: "voice_tone", label: "Voice and signatures" },
  { value: "services_offers", label: "Services and offers" },
  { value: "past_performance", label: "Past results" },
  { value: "certifications_licenses", label: "Licenses and certifications" },
  { value: "team_bios", label: "Team" },
  { value: "financial_data", label: "Funding facts" },
  { value: "speaking", label: "Speaking" },
] as const;
type Category = (typeof CATEGORIES)[number]["value"];

type EntryKind = "fact" | "webpage" | "image" | "document";
const KIND_LABEL: Record<EntryKind, string> = { fact: "Fact", webpage: "Webpage", image: "Image", document: "Document" };

type TabKey = "all" | EntryKind;

const IMAGE_MAX = 8 * 1024 * 1024;
const DOC_MAX = 10 * 1024 * 1024;

type Entry = {
  id: number;
  title: string;
  category: Category;
  kind: EntryKind;
  content: string;
  sourceUrl: string | null;
  fileUrl: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e3e9e6",
  borderRadius: 12,
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minHeight: 190,
  boxSizing: "border-box",
  minWidth: 0,
};

const editStyle: React.CSSProperties = { ...cardStyle, gridColumn: "span 2", borderColor: "#1b6b4a" };

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("That file could not be read."));
    r.readAsDataURL(file);
  });
}

function guessMime(name: string) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf") return "application/pdf";
  if (ext === "md") return "text/markdown";
  if (ext === "csv") return "text/csv";
  return "text/plain";
}

function CategorySelect({ id, value, onChange }: { id: string; value: Category; onChange: (v: Category) => void }) {
  return (
    <select id={id} className="ld-in" value={value} onChange={(e) => onChange(e.target.value as Category)}>
      {CATEGORIES.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

export default function Brain() {
  const { currentOrgId } = useTenant();
  const q = trpc.knowledge.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [tab, setTab] = React.useState<TabKey>("all");
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<number | null>(null);

  const entries = (q.data ?? []) as Entry[];
  const count = (k: EntryKind) => entries.filter((e) => e.kind === k).length;
  const shown = tab === "all" ? entries : entries.filter((e) => e.kind === tab);

  return (
    <Page rail="brain">
      <div className="ld-between">
        <h1 className="ld-h1">Brain</h1>
        <button
          type="button"
          className="ld-btn p"
          onClick={() => {
            setEditing(null);
            setAdding(true);
          }}
        >
          Add entry
        </button>
      </div>

      <FolderTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "all", label: `All (${entries.length})` },
          { key: "fact", label: `Facts (${count("fact")})` },
          { key: "image", label: `Images (${count("image")})` },
          { key: "document", label: `Documents (${count("document")})` },
          { key: "webpage", label: `Webpages (${count("webpage")})` },
        ]}
      >
        <div style={{ padding: 18, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
          {adding && <AddEditor onDone={() => setAdding(false)} />}
          {shown.length === 0 && !adding && (
            <div className="ld-empty" style={{ gridColumn: "1 / -1" }}>
              {q.isLoading ? "Loading..." : "Nothing here yet."}
            </div>
          )}
          {shown.map((e) =>
            editing === e.id ? (
              <EntryEditor key={e.id} entry={e} onDone={() => setEditing(null)} />
            ) : (
              <EntryCard
                key={e.id}
                entry={e}
                onEdit={() => {
                  setAdding(false);
                  setEditing(e.id);
                }}
              />
            )
          )}
        </div>
      </FolderTabs>
    </Page>
  );
}

function EntryCard({ entry: e, onEdit }: { entry: Entry; onEdit: () => void }) {
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <span style={{ fontWeight: 800, fontSize: 15, minWidth: 0, overflowWrap: "anywhere" }}>{e.title}</span>
        <button type="button" className="ld-btn sm" onClick={onEdit} aria-label={`Edit ${e.title}`}>
          Edit
        </button>
      </div>
      {e.kind === "image" && e.fileUrl && (
        <img src={e.fileUrl} alt={e.title} style={{ width: "100%", maxHeight: 140, objectFit: "contain", borderRadius: 8, background: "#f4f8f6" }} />
      )}
      {e.content && (
        <span
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "#3d4c45",
            display: "-webkit-box",
            WebkitLineClamp: 4,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {e.content}
        </span>
      )}
      {e.kind === "webpage" && e.sourceUrl && (
        <a href={e.sourceUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" }}>
          {e.sourceUrl.replace(/^https?:\/\/(www\.)?/, "")}
        </a>
      )}
      {e.kind === "document" && e.fileUrl && (
        <a href={e.fileUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12, fontWeight: 600 }}>
          Open file
        </a>
      )}
      <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#5b6b64" }}>
        <span>{KIND_LABEL[e.kind] ?? "Fact"}</span>
        <span>{fmtDate(e.updatedAt || e.createdAt)}</span>
      </div>
    </div>
  );
}

function EntryEditor({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [title, setTitle] = React.useState(entry.title);
  const [category, setCategory] = React.useState<Category>(entry.category);
  const [content, setContent] = React.useState(entry.content);
  const save = trpc.knowledge.update.useMutation({
    onSuccess: async () => {
      await utils.knowledge.list.invalidate();
      onDone();
    },
  });
  const del = trpc.knowledge.delete.useMutation({
    onSuccess: async () => {
      await utils.knowledge.list.invalidate();
      onDone();
    },
  });
  const id = `b${entry.id}`;
  return (
    <div style={editStyle}>
      <div className="ld-between">
        <span className="ld-lbl">Editing</span>
        <span className="ld-row">
          <button
            type="button"
            className="ld-btn sm danger"
            disabled={del.isPending}
            onClick={() => {
              if (window.confirm(`Delete "${entry.title}" from the Brain?`)) del.mutate({ organizationId: currentOrgId, id: entry.id });
            }}
          >
            Delete
          </button>
          <button type="button" className="ld-btn sm" onClick={onDone}>
            Cancel
          </button>
          <button
            type="button"
            className="ld-btn sm p"
            disabled={save.isPending}
            onClick={() => save.mutate({ organizationId: currentOrgId, id: entry.id, title: title.trim(), category, content: content.trim() })}
          >
            Save
          </button>
        </span>
      </div>
      <label htmlFor={`${id}-title`} className="ld-lbl">Title</label>
      <input id={`${id}-title`} className="ld-in" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor={`${id}-type`} className="ld-lbl">Type</label>
      <CategorySelect id={`${id}-type`} value={category} onChange={setCategory} />
      <label htmlFor={`${id}-content`} className="ld-lbl">{entry.kind === "image" ? "Note" : "What employees should know"}</label>
      <textarea id={`${id}-content`} className="ld-ta" rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
      <ErrorLine error={save.error ?? del.error} />
    </div>
  );
}

function AddEditor({ onDone }: { onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [kind, setKind] = React.useState<EntryKind>("fact");
  const [title, setTitle] = React.useState("");
  const [category, setCategory] = React.useState<Category>("mission_profile");
  const [content, setContent] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const file = files[0] ?? null;
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState(false);
  const [progress, setProgress] = React.useState("");

  const done = async () => {
    await utils.knowledge.list.invalidate();
    onDone();
  };
  const create = trpc.knowledge.create.useMutation({ onSuccess: done });
  const addPage = trpc.knowledge.addWebpage.useMutation({ onSuccess: done });
  const upImage = trpc.knowledge.uploadImage.useMutation({ onSuccess: done });
  const upDoc = trpc.knowledge.uploadDocument.useMutation({ onSuccess: done });
  const busy = reading || Boolean(progress) || create.isPending || addPage.isPending || upImage.isPending || upDoc.isPending;

  const submit = async () => {
    setLocalError(null);
    if (kind === "fact") {
      create.mutate({ organizationId: currentOrgId, title: title.trim(), category, content: content.trim() });
      return;
    }
    if (kind === "webpage") {
      addPage.mutate({ organizationId: currentOrgId, url: url.trim(), title: title.trim() || undefined, category });
      return;
    }
    if (!file) {
      setLocalError("Choose a file.");
      return;
    }
    const max = kind === "image" ? IMAGE_MAX : DOC_MAX;
    // Several photos at once: each one is saved with its file name and described by the app.
    if (kind === "image" && files.length > 1) {
      const big = files.find((f) => f.size > max);
      if (big) {
        setLocalError(`${big.name} is over 8 MB.`);
        return;
      }
      try {
        for (let i = 0; i < files.length; i++) {
          setProgress(`Saving ${i + 1} of ${files.length}...`);
          const data = await readDataUrl(files[i]);
          await upImage.mutateAsync({ organizationId: currentOrgId, title: files[i].name.replace(/\.[a-z0-9]+$/i, ""), note: content.trim(), data });
        }
        setProgress("");
        await done();
      } catch (err) {
        setProgress("");
        setLocalError((err as Error).message);
      }
      return;
    }
    if (file.size > max) {
      setLocalError(kind === "image" ? "Images can be up to 8 MB." : "Documents can be up to 10 MB.");
      return;
    }
    try {
      setReading(true);
      const data = await readDataUrl(file);
      setReading(false);
      const name = title.trim() || file.name;
      if (kind === "image") {
        upImage.mutate({ organizationId: currentOrgId, title: name, note: content.trim(), data });
      } else {
        upDoc.mutate({ organizationId: currentOrgId, title: name, fileName: file.name, mimeType: file.type || guessMime(file.name), category, data });
      }
    } catch (err) {
      setReading(false);
      setLocalError((err as Error).message);
    }
  };

  const id = "bnew";
  return (
    <div style={editStyle}>
      <div className="ld-between">
        <span className="ld-lbl">Adding</span>
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={onDone}>
            Cancel
          </button>
          <button type="button" className="ld-btn sm p" disabled={busy} onClick={submit}>
            {busy ? "Saving..." : "Save"}
          </button>
        </span>
      </div>
      <span className="ld-lbl" id={`${id}-what`}>What are you adding</span>
      <div className="ld-row" role="group" aria-labelledby={`${id}-what`}>
        {(Object.keys(KIND_LABEL) as EntryKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`ld-btn sm ${kind === k ? "p" : ""}`}
            aria-pressed={kind === k}
            onClick={() => {
              setKind(k);
              setFiles([]);
              setLocalError(null);
            }}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {kind === "webpage" && (
        <>
          <label htmlFor={`${id}-url`} className="ld-lbl">Link</label>
          <input id={`${id}-url`} className="ld-in" type="text" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
        </>
      )}

      <label htmlFor={`${id}-title`} className="ld-lbl">{kind === "webpage" ? "Title (optional)" : "Title"}</label>
      <input id={`${id}-title`} className="ld-in" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />

      {kind !== "image" && (
        <>
          <label htmlFor={`${id}-type`} className="ld-lbl">Type</label>
          <CategorySelect id={`${id}-type`} value={category} onChange={setCategory} />
        </>
      )}

      {kind === "fact" && (
        <>
          <label htmlFor={`${id}-content`} className="ld-lbl">What employees should know</label>
          <textarea id={`${id}-content`} className="ld-ta" rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
        </>
      )}

      {kind === "image" && (
        <>
          <label htmlFor={`${id}-note`} className="ld-lbl">Note</label>
          <textarea id={`${id}-note`} className="ld-ta" rows={2} value={content} placeholder="Leave blank to have each photo described" onChange={(e) => setContent(e.target.value)} />
        </>
      )}

      {(kind === "image" || kind === "document") && (
        <>
          <label htmlFor={`${id}-file`} className="ld-lbl">File</label>
          <input
            key={kind}
            id={`${id}-file`}
            type="file"
            className="ld-small"
            accept={kind === "image" ? "image/png,image/jpeg,image/webp,image/gif" : ".pdf,.txt,.md,.csv"}
            multiple={kind === "image"}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        </>
      )}

      {progress && <p className="ld-small ld-muted" style={{ margin: 0 }}>{progress}</p>}
      {localError && (
        <p role="alert" className="ld-small" style={{ color: "#b42318", margin: 0 }}>
          {localError}
        </p>
      )}
      <ErrorLine error={create.error ?? addPage.error ?? upImage.error ?? upDoc.error} />
    </div>
  );
}
