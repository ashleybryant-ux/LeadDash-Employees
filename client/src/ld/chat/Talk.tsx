import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";

/**
 * Files an employee made, opened right in the chat: a talk script reads as a
 * document, a deck flips slide by slide with the speaker notes under it. The
 * Word or PowerPoint file is one click away.
 */

type Slide = { kind: "title" | "points" | "big" | "activity" | "close"; title: string; points: string[]; notes: string };
type Deck = { title: string; event: string; slides: Slide[]; theme?: { dark: string; accent: string } };

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
          {!f ? <p className="ld-small ld-muted" style={{ padding: 16, margin: 0 }}>Opening</p> : kind === "deck" ? <DeckView raw={f.text} /> : <DocView text={f.text} />}
        </div>
      )}
    </div>
  );
}

export function DocCard(props: { id: number; title: string; subtitle?: string }) {
  return <FileCard {...props} kind="doc" />;
}
export function DeckCard(props: { id: number; title: string; subtitle?: string }) {
  return <FileCard {...props} kind="deck" />;
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

export function SlideFace({ s, theme, event, small }: { s: Slide; theme: { dark: string; accent: string }; event?: string; small?: boolean }) {
  const dark = s.kind === "title" || s.kind === "close";
  return (
    <div className={`ld-slide ${small ? "sm" : ""}`} style={{ background: dark ? theme.dark : s.kind === "activity" ? "#f4f8f6" : "#fff", color: dark ? "#fff" : "#24332c" }}>
      {!dark && <span className="ld-slide-bar" style={{ background: theme.accent }} />}
      {dark ? (
        <div className="ld-slide-cover">
          <div className="ld-slide-h1">{s.title}</div>
          <span className="ld-slide-rule" style={{ background: theme.accent }} />
          {(s.points.length ? s.points : s.kind === "title" && event ? [event] : []).map((p, i) => (
            <div key={i} className="ld-slide-sub">{p}</div>
          ))}
        </div>
      ) : s.kind === "big" ? (
        <div className="ld-slide-big">
          <div className="ld-slide-huge" style={{ color: theme.dark }}>{s.title}</div>
          {s.points.map((p, i) => (
            <div key={i} className="ld-slide-sub" style={{ color: "#3d4c45" }}>{p}</div>
          ))}
        </div>
      ) : (
        <div className="ld-slide-body">
          <div className="ld-slide-h2" style={{ color: theme.dark }}>{s.title}</div>
          <ul>
            {s.points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function DeckView({ raw }: { raw: string }) {
  const deck = React.useMemo<Deck | null>(() => {
    try {
      return JSON.parse(raw) as Deck;
    } catch {
      return null;
    }
  }, [raw]);
  const [i, setI] = React.useState(0);
  if (!deck?.slides?.length) return <p className="ld-small ld-muted" style={{ padding: 16, margin: 0 }}>This deck can't be shown here. Download it to open it.</p>;
  const theme = deck.theme ?? { dark: "#0d3b2e", accent: "#e88a3a" };
  const n = deck.slides.length;
  const s = deck.slides[Math.min(i, n - 1)];
  return (
    <div
      className="ld-talk-deck"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") setI((x) => Math.min(n - 1, x + 1));
        if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      }}
    >
      <SlideFace s={s} theme={theme} event={deck.event} />
      <div className="ld-talk-nav">
        <button type="button" className="ld-btn sm" disabled={i === 0} onClick={() => setI(i - 1)}>
          Previous
        </button>
        <span className="ld-small ld-strong">
          Slide {i + 1} of {n}
        </span>
        <button type="button" className="ld-btn sm" disabled={i >= n - 1} onClick={() => setI(i + 1)}>
          Next
        </button>
      </div>
      {s.notes && (
        <div className="ld-talk-notes">
          <span className="ld-lbl">Speaker notes</span>
          <p>{s.notes}</p>
        </div>
      )}
      <div className="ld-talk-strip" role="list" aria-label="All slides">
        {deck.slides.map((x, k) => (
          <button type="button" key={k} role="listitem" aria-label={`Slide ${k + 1}: ${x.title}`} className={k === i ? "on" : ""} onClick={() => setI(k)}>
            <SlideFace s={x} theme={theme} event={deck.event} small />
          </button>
        ))}
      </div>
    </div>
  );
}
