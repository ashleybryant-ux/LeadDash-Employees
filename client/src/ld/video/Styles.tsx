import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { uploadTo } from "./VideoAgent";

/**
 * The look of a video: Real footage, Auto (Elena picks), the preset drawn styles, and styles a
 * workspace makes from its own pictures. The Style row shows four; All styles opens the picker.
 */

export type StyleItem = { key: string; label: string; image: string | null };

export const REAL: StyleItem = { key: "real", label: "Real footage", image: "/api/video-pictures/broll" };
export const AUTO: StyleItem = { key: "auto", label: "Auto", image: null };
const QUICK = ["animation", "claymation", "watercolor"];

export function useStyles() {
  const { currentOrgId } = useTenant();
  const q = trpc.videos.styles.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const all: StyleItem[] = [AUTO, REAL, ...(q.data?.custom ?? []), ...(q.data?.presets ?? [])];
  return { all, find: (key: string) => all.find((s) => s.key === key) ?? { key, label: key, image: null }, count: all.length };
}

function Tile({ s, on, onClick }: { s: StyleItem; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`ld-sty ${on ? "on" : ""}`} aria-pressed={on} onClick={onClick}>
      <span className={`ld-sty-img ${s.key === "auto" ? "auto" : ""}`}>
        {s.key === "auto" ? (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" /><path d="m14 7 3 3M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9" /></svg>
        ) : s.image ? (
          <img src={s.image} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
        ) : null}
      </span>
      <b>{s.label}</b>
    </button>
  );
}

/** The Style row on Make a video: Real footage, three styles (or the one picked), and All styles. */
export function StyleRow({ value, onChange, realLabel }: { value: string; onChange: (key: string) => void; realLabel?: string }) {
  const st = useStyles();
  const [open, setOpen] = React.useState(false);
  const keys = ["real", ...QUICK];
  if (!keys.includes(value)) keys[keys.length - 1] = value;
  return (
    <div className="ld-vm-field">
      <span className="ld-lbl">Style</span>
      <div className="ld-sty-quick">
        {keys.map((k) => (
          <Tile key={k} s={k === "real" && realLabel ? { ...st.find(k), label: realLabel } : st.find(k)} on={value === k} onClick={() => onChange(k)} />
        ))}
        <button type="button" className="ld-sty-more" onClick={() => setOpen(true)}>
          All styles
          <span>{`${st.count} styles`}</span>
        </button>
      </div>
      {open && <StylePicker value={value} onPick={(k) => (onChange(k), setOpen(false))} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Columns that fill the rows (or leave the fullest last row), so no picture sits alone in a row. */
export function columnsFor(n: number, opts = [5, 6, 7, 4]) {
  return opts.find((c) => n % c === 0) ?? opts.reduce((best, c) => ((n % c) > (n % best) ? c : best), opts[0]);
}

/** Choose a style: a lightbox with every look. Picking one closes it. */
export function StylePicker({ value, onPick, onClose, title = "Choose a style" }: { value: string; onPick: (key: string) => void; onClose: () => void; title?: string }) {
  const st = useStyles();
  const [adding, setAdding] = React.useState(false);
  React.useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="ld-lb" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ld-lb-box">
        <div className="ld-lb-hd">
          <b>{adding ? "Add a style" : title}</b>
          <button type="button" className="ld-lb-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {adding ? (
          <AddStyle onSaved={(k) => onPick(k)} onCancel={() => setAdding(false)} />
        ) : (
          <div className="ld-sty-grid" style={{ ["--cols" as string]: String(columnsFor(st.all.length + 1)), ["--cols-sm" as string]: String(columnsFor(st.all.length + 1, [3, 4])) }}>
            <button type="button" className="ld-sty" onClick={() => setAdding(true)}>
              <span className="ld-sty-img add">+</span>
              <b>Add style</b>
            </button>
            {st.all.map((s) => (
              <Tile key={s.key} s={s} on={value === s.key} onClick={() => onPick(s.key)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Add style: 1 to 3 pictures in the look, and a name. Saved for every video after this one. */
function AddStyle({ onSaved, onCancel }: { onSaved: (key: string) => void; onCancel: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [refs, setRefs] = React.useState<string[]>([]);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const add = trpc.videos.addStyle.useMutation({ onSuccess: async (s) => (await utils.videos.styles.invalidate(), onSaved(s.key)) });
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    setBusy(true);
    try {
      const next = [...refs];
      for (const f of Array.from(files).slice(0, 3 - refs.length)) next.push((await uploadTo<{ url: string }>("style_ref", currentOrgId, f)).url);
      setRefs(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ld-sty-add">
      <span className="ld-lbl">Pictures in this look (1 to 3)</span>
      <div className="ld-sty-refs">
        {refs.map((u) => (
          <span key={u} className="ld-sty-ref">
            <img src={u} alt="" />
            <button type="button" aria-label="Remove picture" onClick={() => setRefs(refs.filter((x) => x !== u))}>✕</button>
          </span>
        ))}
        {refs.length < 3 && (
          <button type="button" className="ld-sty-ref up" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Uploading..." : "Upload picture"}
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => (upload(e.target.files), (e.target.value = ""))} />
      </div>
      <label className="ld-vm-field" htmlFor="style-name">
        <span className="ld-lbl">Name</span>
        <input id="style-name" className="ld-in" style={{ maxWidth: 360 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Our brand look" />
      </label>
      {err && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{err}</span>}
      <ErrorLine error={add.error} />
      <div className="ld-row" style={{ gap: 8 }}>
        <button type="button" className="ld-btn p" style={{ width: 150 }} disabled={!refs.length || !name.trim() || add.isPending || busy} onClick={() => add.mutate({ organizationId: currentOrgId, name, refs })}>
          {add.isPending ? "Saving..." : "Save"}
        </button>
        <button type="button" className="ld-btn" style={{ width: 150 }} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
