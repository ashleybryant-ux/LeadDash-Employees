import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";

/**
 * Files an employee made, opened right in the chat: a talk script reads as a
 * document, a deck flips slide by slide with the speaker notes under it. The
 * Word or PowerPoint file is one click away.
 */

type Slide = { kind: "title" | "section" | "points" | "big" | "activity" | "close"; title: string; points: string[]; notes: string; picture?: string; image?: string | null };
type Deck = { title: string; event: string; slides: Slide[]; theme?: { dark: string; accent: string }; headshot?: string | null };

function useFile(id: number, enabled: boolean) {
  const { currentOrgId } = useTenant();
  return trpc.chat.fileView.useQuery({ organizationId: currentOrgId, id }, { enabled: enabled && currentOrgId > 0, staleTime: 5 * 60_000 });
}

function FileCard({ id, title, subtitle, kind }: { id: number; title: string; subtitle?: string; kind: "doc" | "deck" }) {
  const [open, setOpen] = React.useState(false);
  const q = useFile(id, true);
  const f = q.data;
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-talk-head">
        <span className="ld-talk-ic" style={{ background: kind === "deck" ? "#fdf0e3" : "#e4eef8", color: kind === "deck" ? "#8a4510" : "#1f4f7a" }}>{kind === "deck" ? "PPT" : "DOC"}</span>
        <span style={{ minWidth: 0 }}>
          <span className="ld-strong" style={{ display: "block" }}>{title}</span>
          {subtitle && <span className="ld-small ld-muted">{subtitle}</span>}
        </span>
        <span className="ld-talk-btns">
          <button type="button" className="ld-btn p" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Close" : "Open"}
          </button>
          {f && (
            <a className="ld-btn" href={f.url} download={f.name}>
              Download
            </a>
          )}
        </span>
      </div>
      {open && (
        <div style={{ borderTop: "1px solid #e3e9e6" }}>
          <ErrorLine error={q.error} />
          {!f ? <p className="ld-small ld-muted" style={{ padding: 16, margin: 0 }}>Opening</p> : kind === "deck" ? <DeckView raw={f.text} fileId={f.id} url={f.url} name={f.name} /> : <DocView text={f.text} />}
        </div>
      )}
    </div>
  );
}

export function DocCard(props: { id: number; title: string; subtitle?: string }) {
  return <FileCard {...props} kind="doc" />;
}
/** The deck shows right in the chat: no Open needed. */
export function DeckCard({ id, title, subtitle }: { id: number; title: string; subtitle?: string }) {
  const q = useFile(id, true);
  const f = q.data;
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-talk-head" style={{ gridTemplateColumns: "44px minmax(0, 1fr)", borderBottom: "1px solid #e3e9e6" }}>
        <span className="ld-talk-ic" style={{ background: "#fdf0e3", color: "#8a4510" }}>PPT</span>
        <span style={{ minWidth: 0 }}>
          <span className="ld-strong" style={{ display: "block" }}>{title}</span>
          {subtitle && <span className="ld-small ld-muted">{subtitle}</span>}
        </span>
      </div>
      <ErrorLine error={q.error} />
      {!f ? <p className="ld-small ld-muted" style={{ padding: 16, margin: 0 }}>Loading the slides</p> : <DeckView raw={f.text} fileId={f.id} url={f.url} name={f.name} />}
    </div>
  );
}

// ==========================================
// The script, as a document
// ==========================================

function inline(t: string) {
  // **bold** only; everything else is plain text.
  return t.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (/^\*\*[^*]+\*\*$/.test(part) ? <b key={i}>{part.slice(2, -2)}</b> : <React.Fragment key={i}>{part}</React.Fragment>));
}

export function DocView({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className="ld-talk-doc">
      {blocks.map((b, i) => {
        if (b.startsWith("# ")) return <h2 key={i}>{b.slice(2)}</h2>;
        if (b.startsWith("## ")) {
          const [head, ...rest] = b.split("\n");
          return (
            <React.Fragment key={i}>
              <h3>{head.slice(3)}</h3>
              {rest.length > 0 && <p className="ld-talk-cue">{inline(rest.join(" "))}</p>}
            </React.Fragment>
          );
        }
        if (/^_.*_$/.test(b)) return <p key={i} className="ld-talk-meta">{b.slice(1, -1)}</p>;
        if (/^\*\*.*\*\*$/.test(b)) return <p key={i} className="ld-talk-cue">{inline(b)}</p>;
        if (/^\[.*\]$/.test(b)) return <p key={i} className="ld-talk-dir">{b}</p>;
        return <p key={i}>{inline(b)}</p>;
      })}
    </div>
  );
}

// ==========================================
// The deck, slide by slide
// ==========================================

export function SlideFace({ s, theme, event, headshot, small }: { s: Slide; theme: { dark: string; accent: string }; event?: string; headshot?: string | null; small?: boolean }) {
  const dark = s.kind === "title" || s.kind === "close";
  const pic = s.image ?? null;
  // The tag sits on the picture: right side on a points slide, left on an activity or section slide.
  const tag = pic && !small ? <span className="ld-slide-ai" style={s.kind === "points" ? { left: "auto", right: 8 } : undefined}>AI picture</span> : null;
  if (s.kind === "section" && pic) {
    return (
      <div className={`ld-slide ${small ? "sm" : ""}`} style={{ background: theme.dark, color: "#fff" }}>
        <img src={pic} alt="" className="ld-slide-img" style={{ inset: 0, width: "100%", height: "100%" }} />
        <span className="ld-slide-shade" style={{ background: `linear-gradient(90deg, ${theme.dark}EE 0%, ${theme.dark}99 55%, ${theme.dark}00 100%)` }} />
        <div className="ld-slide-cover" style={{ right: "40%" }}>
          <div className="ld-slide-h1">{s.title}</div>
          <span className="ld-slide-rule" style={{ background: theme.accent }} />
        </div>
        {tag}
      </div>
    );
  }
  if (dark) {
    const head = s.kind === "title" ? headshot : null;
    return (
      <div className={`ld-slide ${small ? "sm" : ""}`} style={{ background: theme.dark, color: "#fff" }}>
        <div className="ld-slide-cover" style={head ? { right: "34%" } : undefined}>
          <div className="ld-slide-h1">{s.title}</div>
          <span className="ld-slide-rule" style={{ background: theme.accent }} />
          {(s.points.length ? s.points : s.kind === "title" && event ? [event] : []).map((p, i) => (
            <div key={i} className="ld-slide-sub">{p}</div>
          ))}
        </div>
        {head && <img src={head} alt="Headshot" className="ld-slide-img" style={{ right: "6%", top: "14%", width: "24%", height: "72%", borderRadius: "1.2cqw" }} />}
      </div>
    );
  }
  if (s.kind === "big") {
    return (
      <div className={`ld-slide ${small ? "sm" : ""}`} style={{ background: "#fff", color: "#24332c" }}>
        <span className="ld-slide-bar" style={{ background: theme.accent }} />
        <div className="ld-slide-big">
          <div className="ld-slide-huge" style={{ color: theme.dark }}>{s.title}</div>
          {s.points.map((p, i) => (
            <div key={i} className="ld-slide-sub" style={{ color: "#3d4c45" }}>{p}</div>
          ))}
        </div>
      </div>
    );
  }
  const picLeft = s.kind === "activity";
  return (
    <div className={`ld-slide ${small ? "sm" : ""}`} style={{ background: s.kind === "activity" ? "#f4f8f6" : "#fff", color: "#24332c" }}>
      {pic && <img src={pic} alt="" className="ld-slide-img" style={{ top: 0, bottom: 0, height: "100%", width: picLeft ? "37%" : "43%", [picLeft ? "left" : "right"]: 0 }} />}
      {(!pic || !picLeft) && <span className="ld-slide-bar" style={{ background: theme.accent }} />}
      <div className="ld-slide-body" style={pic ? (picLeft ? { left: "40%" } : { right: "45%" }) : undefined}>
        <div className="ld-slide-h2" style={{ color: theme.dark }}>{s.title}</div>
        <ul>
          {s.points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </div>
      {tag}
    </div>
  );
}

function NotesBox({ fileId, index, notes }: { fileId: number; index: number; notes: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(notes);
  const save = trpc.chat.saveSlideNotes.useMutation({
    onSuccess: async () => {
      await utils.chat.fileView.invalidate({ organizationId: currentOrgId, id: fileId });
      setEditing(false);
    },
  });
  React.useEffect(() => {
    setEditing(false);
    setDraft(notes);
  }, [index, notes]);
  return (
    <div className={`ld-talk-notes ${editing ? "editing" : ""}`}>
      <div className="ld-between">
        <span className="ld-lbl">Presenter notes{editing ? ` · slide ${index + 1}` : ""}</span>
        {editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => { setEditing(false); setDraft(notes); }}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: fileId, index, notes: draft })}>
              {save.isPending ? "Saving" : "Save"}
            </button>
          </span>
        ) : (
          <button type="button" className="ld-btn sm" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>
      {editing ? (
        <>
          <textarea className="ld-ta" rows={4} value={draft} aria-label={`Presenter notes for slide ${index + 1}`} onChange={(e) => setDraft(e.target.value)} style={{ marginTop: 8 }} />
          <span className="ld-small ld-muted">Saved to this slide's presenter notes in the PowerPoint.</span>
        </>
      ) : notes ? (
        <p>{notes}</p>
      ) : (
        <p className="ld-muted">No notes on this slide yet.</p>
      )}
      <ErrorLine error={save.error} />
    </div>
  );
}

export function DeckView({ raw, fileId, url, name }: { raw: string; fileId: number; url: string; name: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const deck = React.useMemo<Deck | null>(() => {
    try {
      return JSON.parse(raw) as Deck;
    } catch {
      return null;
    }
  }, [raw]);
  const [i, setI] = React.useState(0);
  const stage = React.useRef<HTMLDivElement>(null);
  const picture = trpc.chat.newSlidePicture.useMutation({ onSuccess: () => utils.chat.fileView.invalidate({ organizationId: currentOrgId, id: fileId }) });
  if (!deck?.slides?.length) return <p className="ld-small ld-muted" style={{ padding: 16, margin: 0 }}>This deck can't be shown here. Download it to open it.</p>;
  const theme = deck.theme ?? { dark: "#1E2A44", accent: "#E3B457" };
  const n = deck.slides.length;
  const at = Math.min(i, n - 1);
  const s = deck.slides[at];
  const go = (k: number) => setI(Math.max(0, Math.min(n - 1, k)));
  const canPicture = s.kind !== "title";
  const full = () => {
    const el = stage.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };
  return (
    <div className="ld-talk-deck2">
      <div style={{ minWidth: 0 }}>
        <div
          ref={stage}
          className="ld-talk-stage"
          tabIndex={0}
          aria-label={`Slide ${at + 1} of ${n}`}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === " ") go(at + 1);
            if (e.key === "ArrowLeft") go(at - 1);
          }}
          onClick={() => document.fullscreenElement && go(at + 1)}
        >
          <SlideFace s={s} theme={theme} event={deck.event} headshot={deck.headshot} />
        </div>
        <div className="ld-talk-nav" style={{ marginTop: 10 }}>
          <button type="button" className="ld-btn sm" disabled={at === 0} onClick={() => go(at - 1)}>Previous</button>
          <span className="ld-small ld-strong">Slide {at + 1} of {n}</span>
          <button type="button" className="ld-btn sm" disabled={at >= n - 1} onClick={() => go(at + 1)}>Next</button>
        </div>
        {picture.isPending && <p className="ld-small ld-muted" role="status" style={{ margin: "8px 0 0" }}>Making a new picture for slide {at + 1}. It takes about half a minute.</p>}
        <ErrorLine error={picture.error} />
        <NotesBox fileId={fileId} index={at} notes={s.notes} />
        <div className="ld-talk-strip" role="list" aria-label="All slides">
          {deck.slides.map((x, k) => (
            <button type="button" key={k} role="listitem" aria-label={`Slide ${k + 1}: ${x.title}`} className={k === at ? "on" : ""} onClick={() => go(k)}>
              <SlideFace s={x} theme={theme} event={deck.event} headshot={deck.headshot} small />
            </button>
          ))}
        </div>
      </div>
      <div className="ld-talk-side">
        <a className="ld-btn" href={url} download={name}>Download</a>
        {canPicture && (
          <button type="button" className="ld-btn" disabled={picture.isPending} onClick={() => picture.mutate({ organizationId: currentOrgId, id: fileId, index: at, describe: "" })}>
            {picture.isPending ? "Making" : "New picture"}
          </button>
        )}
        <button type="button" className="ld-btn" onClick={full}>Full screen</button>
      </div>
    </div>
  );
}
