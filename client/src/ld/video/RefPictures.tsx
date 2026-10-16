import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";

/**
 * A Scene's reference pictures (2026-10-16): up to 6 of her own pictures, each with an
 * optional note on what it's for ("This is Dr. Cohen", "Her office should feel like this").
 * There are no kinds to pick: Elena works out how to use each one from the note and the brief.
 * - RefPicker: the editable row (Add pictures, a note under each, x to take one out).
 * - RefsSection: on a written scene, read only with Edit; Save writes the scene again with them.
 */

export type RefPick = { url: string; note: string; seen?: string };
export const MAX_REFS = 6;

async function uploadPicture(orgId: number, file: File) {
  const q = new URLSearchParams({ organizationId: String(orgId), name: file.name });
  const res = await fetch(`/api/upload/scene_ref?${q.toString()}`, { method: "POST", body: file, credentials: "include", headers: { "content-type": file.type || "application/octet-stream" } });
  const data = await res.json().catch(() => ({ error: res.status === 413 ? "That picture is too large." : "Upload failed." }));
  if (!res.ok) throw new Error(data.error || "Upload failed.");
  return { url: String(data.url), note: "", seen: String(data.seen || "") } as RefPick;
}

export function RefPicker({ orgId, value, onChange }: { orgId: number; value: RefPick[]; onChange: (v: RefPick[]) => void }) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const add = async (list: FileList | null) => {
    const files = Array.from(list ?? []).slice(0, MAX_REFS - value.length);
    if (!files.length) return;
    setErr(null);
    setBusy(true);
    let next = value;
    try {
      for (const f of files) {
        next = [...next, await uploadPicture(orgId, f)];
        onChange(next);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  return (
    <>
      <div className="ld-refs">
        {value.map((r, i) => (
          <div className="ld-ref" key={r.url}>
            <div className="ld-ref-pic">
              <img src={r.url} alt="" />
              <button type="button" className="ld-ref-x" aria-label={`Remove picture ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
            </div>
            <input className="ld-in xs" aria-label={`What picture ${i + 1} is for`} placeholder="Note (optional)" maxLength={200} value={r.note} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
          </div>
        ))}
        {value.length < MAX_REFS && (
          <button type="button" className="ld-ref-add" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Uploading..." : "Add pictures"}
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => void add(e.target.files)} />
      <span className="ld-small">Up to 6. Elena works out how to use each one from your note and what you wrote above.</span>
      {err && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{err}</span>}
    </>
  );
}

export function RefsSection({ orgId, id, refs, busy, onSaved }: { orgId: number; id: number; refs: RefPick[]; busy: boolean; onSaved: () => Promise<unknown> }) {
  const [edit, setEdit] = React.useState(false);
  const [draft, setDraft] = React.useState<RefPick[]>(refs);
  const save = trpc.scenes.saveRefs.useMutation({ onSuccess: async () => (await onSaved(), setEdit(false)) });
  const changed = JSON.stringify(draft.map((r) => [r.url, r.note.trim()])) !== JSON.stringify(refs.map((r) => [r.url, r.note.trim()]));
  return (
    <div className="ld-vm-field">
      <div className="ld-refs-head">
        <span className="ld-lbl">Reference pictures</span>
        {!edit && (
          <button type="button" className="ld-btn sm" style={{ width: 90 }} disabled={busy} onClick={() => (setDraft(refs), setEdit(true))}>Edit</button>
        )}
      </div>
      {edit ? (
        <>
          <RefPicker orgId={orgId} value={draft} onChange={setDraft} />
          {changed && <span className="ld-small">Saving writes the scene again with these pictures, and its pictures are made again.</span>}
          <div className="ld-row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => setEdit(false)}>Cancel</button>
            <button type="button" className="ld-btn p" style={{ width: 100 }} disabled={save.isPending || !changed} onClick={() => save.mutate({ organizationId: orgId, id, refs: draft.map((r) => ({ url: r.url, note: r.note.trim(), ...(r.seen ? { seen: r.seen } : {}) })) })}>
              {save.isPending ? "Saving" : "Save"}
            </button>
          </div>
          <ErrorLine error={save.error} />
        </>
      ) : refs.length ? (
        <div className="ld-refs">
          {refs.map((r) => (
            <div className="ld-ref" key={r.url}>
              <div className="ld-ref-pic">
                <img src={r.url} alt="" />
              </div>
              <span className={`ld-ref-note ${r.note ? "" : "none"}`}>{r.note || "No note"}</span>
            </div>
          ))}
        </div>
      ) : (
        <span className="ld-small">None. Press Edit to add pictures of a person, a place or anything else you want in it.</span>
      )}
    </div>
  );
}
