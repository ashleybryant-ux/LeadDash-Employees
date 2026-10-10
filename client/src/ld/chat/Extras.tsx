import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { parseJson, uploadFile } from "../meta";

/**
 * The parts of a chat that make it a conversation: quick replies, attachments,
 * Jordan's layout choice and inline page previews, and Morgan's application
 * draft and rewritten answers.
 */

// ==========================================
// Attachments
// ==========================================

export type Attached = { id: number; name: string; size: number; kind: "image" | "document"; url: string };
type Staged = { key: string; name: string; size: number; file?: Attached; error?: string };

export const MAX_FILES = 10;
export const MAX_BYTES = 20_000_000;
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.html,.htm";

export function fileSize(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1000))} KB`;
}

function extLabel(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ({ pdf: "PDF", docx: "DOC", xlsx: "XLS", pptx: "PPT", csv: "CSV", txt: "TXT", md: "TXT" } as Record<string, string>)[ext] ?? "FILE";
}

const CLIP = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.4 11.1l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
  </svg>
);
const X = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export function AttachmentChip({ f, onRemove, busy, error }: { f: { name: string; size: number; kind?: string; url?: string }; onRemove?: () => void; busy?: boolean; error?: string }) {
  const inner = (
    <>
      {f.kind === "image" && f.url ? <img src={f.url} alt="" /> : <span className="ic">{extLabel(f.name)}</span>}
      <span className="nm">{f.name}</span>
      <span className="sz" style={error ? { color: "var(--ld-bad)" } : undefined}>{error ? "Didn't upload" : busy ? "Uploading..." : fileSize(f.size)}</span>
      {onRemove && (
        <button type="button" className="x" aria-label={`Remove ${f.name}`} onClick={onRemove}>
          {X}
        </button>
      )}
    </>
  );
  if (!onRemove && f.url)
    return (
      <a className="ld-att" href={f.url} target="_blank" rel="noreferrer noopener">
        {inner}
      </a>
    );
  return <span className="ld-att">{inner}</span>;
}

/** The paperclip and the files waiting to go with the next message. Files upload as soon as they are picked. */
export function useAttachments(orgId: number, employeeId: number, slot: "chat" | "team" = "chat") {
  const [staged, setStaged] = React.useState<Staged[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const input = React.useRef<HTMLInputElement>(null);

  const add = (list: FileList | File[] | null) => {
    if (!list) return;
    setNote(null);
    const room = MAX_FILES - staged.length;
    const files = Array.from(list).slice(0, Math.max(0, room));
    if (list.length > room) setNote(`Up to ${MAX_FILES} files per message.`);
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      if (file.size > MAX_BYTES) {
        setStaged((s) => [...s, { key, name: file.name, size: file.size, error: "Files must be under 20 MB." }]);
        continue;
      }
      setStaged((s) => [...s, { key, name: file.name, size: file.size }]);
      uploadFile(slot, file, { organizationId: orgId, employeeId })
        .then((r: Attached) => setStaged((s) => s.map((x) => (x.key === key ? { ...x, file: r } : x))))
        .catch((err: Error) => setStaged((s) => s.map((x) => (x.key === key ? { ...x, error: err.message } : x))));
    }
  };

  const ready = staged.filter((s) => s.file).map((s) => s.file!);
  const uploading = staged.some((s) => !s.file && !s.error);

  const button = (
    <>
      <input ref={input} type="file" multiple accept={ACCEPT} style={{ display: "none" }} onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      <button type="button" className="ld-attach-btn" aria-label="Attach files" onClick={() => input.current?.click()} disabled={staged.length >= MAX_FILES}>
        {CLIP}
      </button>
    </>
  );

  const chips = staged.length ? (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {staged.map((s) => (
        <AttachmentChip key={s.key} f={{ name: s.name, size: s.size, kind: s.file?.kind, url: s.file?.url }} busy={!s.file && !s.error} error={s.error} onRemove={() => setStaged((list) => list.filter((x) => x.key !== s.key))} />
      ))}
    </div>
  ) : null;

  const errors = staged.filter((s) => s.error).map((s) => `${s.name}: ${s.error}`);
  /** Long pasted text (a page's HTML, a long document) goes with the message as a file instead of into the box. */
  const addText = (text: string) => {
    const html = /<(!doctype html|html|head|body|div|section|style|script)[\s>]/i.test(text);
    const stamp = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/[: ]/g, "");
    add([new File([text], html ? `pasted-page-${stamp}.html` : `pasted-text-${stamp}.txt`, { type: html ? "text/html" : "text/plain" })]);
  };
  return { button, chips, ready, uploading, clear: () => setStaged([]), note: note ?? (errors.length ? errors.join(" ") : null), onDrop: add, addText };
}

export function MessageAttachments({ raw }: { raw: string | null | undefined }) {
  const list = parseJson<Attached[]>(raw ?? null, []);
  if (!list.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
      {list.map((f) => (
        <AttachmentChip key={f.id} f={f} />
      ))}
    </div>
  );
}

// ==========================================
// Quick replies
// ==========================================

export function QuickReplies({ options, onPick, disabled }: { options: string[]; onPick: (s: string) => void; disabled?: boolean }) {
  if (!options.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={o} type="button" className="ld-qr" disabled={disabled} onClick={() => onPick(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

// ==========================================
// Jordan: layout choice and the page in chat
// ==========================================

const SKETCH: Record<string, React.ReactNode> = {
  "Photo beside headline": (
    <>
      <div style={{ display: "flex", gap: 6, flex: 1 }}>
        <div style={{ flex: 1.2, display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="d" style={{ height: 8, width: "80%" }} />
          <div className="d" style={{ height: 8, width: "60%" }} />
          <div className="b" style={{ height: 5, width: "90%" }} />
          <div className="b" style={{ height: 5, width: "70%" }} />
          <div className="c" style={{ marginTop: 2 }} />
        </div>
        <div className="d" style={{ flex: 1 }} />
      </div>
      <div className="b" style={{ height: 10 }} />
    </>
  ),
  "Big headline first": (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center", paddingTop: 6 }}>
        <div className="d" style={{ height: 10, width: "85%" }} />
        <div className="d" style={{ height: 10, width: "55%" }} />
        <div className="c" style={{ marginTop: 4 }} />
      </div>
      <div style={{ display: "flex", gap: 5, flex: 1, marginTop: 4 }}>
        <div className="b" style={{ flex: 1 }} />
        <div className="b" style={{ flex: 1 }} />
        <div className="b" style={{ flex: 1 }} />
      </div>
    </>
  ),
  "Story first": (
    <>
      <div className="d" style={{ height: 34 }} />
      <div className="b" style={{ height: 5, width: "90%" }} />
      <div className="b" style={{ height: 5, width: "80%" }} />
      <div className="b" style={{ height: 5, width: "85%" }} />
      <div className="c" />
    </>
  ),
};
const SUB: Record<string, string> = { "Photo beside headline": "Your photo carries the page", "Big headline first": "The promise carries the page", "Story first": "Opens with the problem and why it matters" };

export function LayoutChoiceCard({ options, onPick, disabled }: { options: string[]; onPick: (s: string) => void; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={o} type="button" className="ld-opt" disabled={disabled} onClick={() => onPick(o)}>
          <div className="ld-wf">{SKETCH[o]}</div>
          <span style={{ fontWeight: 800, fontSize: 14 }}>{o}</span>
          {SUB[o] && <span className="ld-small ld-muted">{SUB[o]}</span>}
        </button>
      ))}
    </div>
  );
}

/** One version of a page Jordan built, live in the chat: desktop or phone, full screen, Copy HTML, Approve. */
export function PagePreviewCard({ id, version, title, kind }: { id: number; version?: number; title: string; kind: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.pages.get.useQuery({ organizationId: currentOrgId, id, version }, { staleTime: 60_000 });
  const approve = trpc.pages.approve.useMutation({ onSuccess: () => { utils.pages.invalidate(); } });
  const [phone, setPhone] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  // Desktop shows the page at a real desktop width (1280px) scaled down to fit, so it lays out the way a laptop shows it.
  const DESK = 1280;
  const box = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.65);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / DESK));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const v = q.data?.version ?? version ?? 0;
  const approved = q.data?.page.status === "approved";
  const full = () => {
    if (!q.data?.document) return;
    const url = URL.createObjectURL(new Blob([q.data.document], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const copy = async () => {
    if (!q.data?.html) return;
    await navigator.clipboard.writeText(q.data.html);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="ld-card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, maxWidth: 860 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span className="ld-lbl">{`${kind} · version ${v}`}</span>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{title}</span>
        </div>
        <div className="ld-seg" role="group" aria-label="Preview size">
          <button type="button" className={phone ? "" : "on"} aria-pressed={!phone} onClick={() => setPhone(false)}>Desktop</button>
          <button type="button" className={phone ? "on" : ""} aria-pressed={phone} onClick={() => setPhone(true)}>Phone</button>
        </div>
      </div>
      <div className="ld-frame">
        <div className="bar">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
          <span style={{ marginLeft: 8 }}>Live preview · scroll inside to see the whole page</span>
        </div>
        <div ref={box} style={{ background: phone ? "var(--ld-line2)" : "#fff", display: "flex", justifyContent: "center", overflow: "hidden", height: 460 }}>
          {q.data?.document ? (
            phone ? (
              <iframe title={`${title}, version ${v}`} srcDoc={q.data.document} sandbox="allow-same-origin" style={{ width: 390, maxWidth: "100%", height: 460, border: 0, background: "var(--ld-surface)", display: "block" }} />
            ) : (
              <div style={{ width: "100%", height: 460, position: "relative" }}>
                <iframe title={`${title}, version ${v}`} srcDoc={q.data.document} sandbox="allow-same-origin" style={{ width: DESK, height: 460 / scale, border: 0, background: "var(--ld-surface)", display: "block", transform: `scale(${scale})`, transformOrigin: "top left", position: "absolute", top: 0, left: 0 }} />
              </div>
            )
          ) : (
            <div className="ld-empty" style={{ padding: 40 }}>{q.isLoading ? "Loading the preview..." : "This version isn't available."}</div>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="ld-btn p" onClick={full} disabled={!q.data?.document}>Full screen</button>
        <button type="button" className="ld-btn" onClick={copy} disabled={!q.data?.html}>{copied ? "Copied" : "Copy HTML"}</button>
        {approved ? <span className="ld-pill green" style={{ alignSelf: "center" }}>Approved</span> : <button type="button" className="ld-btn" disabled={approve.isPending} onClick={() => approve.mutate({ organizationId: currentOrgId, id })}>Approve</button>}
      </div>
      <ErrorLine error={q.error || approve.error} />
    </div>
  );
}

// ==========================================
// Morgan: the application draft and rewritten answers
// ==========================================

type Question = { id: string; text: string; answer: string; maxWords: number; status: string };
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function ApplicationDraftCard({ id, base }: { id: number; base: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.applications.get.useQuery({ organizationId: currentOrgId, id }, { staleTime: 30_000 });
  const submit = trpc.applications.submit.useMutation({ onSuccess: () => utils.applications.invalidate() });
  const [all, setAll] = React.useState(false);
  if (!q.data) return <div className="ld-card" style={{ padding: 16 }}>{q.isLoading ? "Loading the draft..." : "This application isn't available."}</div>;
  const { app, questions: open } = q.data;
  const qs = parseJson<Question[]>(app.questions, []);
  const shown = all ? qs : qs.slice(0, 2);
  const status = app.status === "ready" ? { l: "Waiting for you", c: "amber" } : app.status === "needs_answer" ? { l: `${open.length || 1} needs you`, c: "amber" } : app.status === "approved" ? { l: "Approved", c: "green" } : app.status === "submitted" ? { l: "Submitted", c: "green" } : { l: app.status === "writing" ? "Writing" : "Draft", c: "gray" };
  return (
    <div className="ld-card" style={{ padding: 0, maxWidth: 860 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span className="ld-lbl">{app.mode === "outline" ? "Application · outline" : "Application · draft"}</span>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{app.title}</span>
        </div>
        <span className={`ld-pill ${status.c}`}>{status.l}</span>
      </div>
      {shown.map((x) => (
        <div key={x.id} className="ld-qa">
          <span style={{ fontWeight: 800, fontSize: 14 }}>{x.text}</span>
          <span style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{x.answer || <span className="ld-muted">Not written yet.</span>}</span>
          <span className="ld-small ld-muted">{`${words(x.answer)}${x.maxWords ? ` of ${x.maxWords}` : ""} words`}</span>
        </div>
      ))}
      <div style={{ padding: "12px 16px", borderTop: "1px solid #eef2f0", display: "flex", gap: 8, flexWrap: "wrap" }}>
        {qs.length > 2 && <button type="button" className="ld-btn" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${qs.length}`}</button>}
        <Link href={`${base}/app/${id}`} className="ld-btn">Open full page</Link>
        {app.status === "ready" && <button type="button" className="ld-btn p" disabled={submit.isPending} onClick={() => submit.mutate({ organizationId: currentOrgId, id })}>Approve</button>}
      </div>
      <ErrorLine error={submit.error} />
    </div>
  );
}

/** Highlights the sentences that are new compared with the answer before the rewrite. */
function marked(after: string, before: string) {
  const old = new Set(before.split(/(?<=[.!?])\s+/).map((x) => x.trim()));
  return after.split(/(?<=[.!?])\s+/).map((sentence, i) => (
    <React.Fragment key={i}>
      {i > 0 ? " " : ""}
      {old.has(sentence.trim()) ? sentence : <span className="ld-mark">{sentence}</span>}
    </React.Fragment>
  ));
}

export function AnswerCard({ title, body, before, subtitle }: { title: string; body: string; before: string; subtitle?: string }) {
  return (
    <div className="ld-card" style={{ padding: 0, maxWidth: 860 }}>
      <div className="ld-qa" style={{ borderTop: 0 }}>
        <span style={{ fontWeight: 800, fontSize: 14 }}>{`${title} (new)`}</span>
        <span style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{marked(body, before)}</span>
        <span className="ld-small ld-muted">{`${subtitle ?? `${words(body)} words`}${before && before !== body ? " · Highlighted: new" : ""}`}</span>
      </div>
    </div>
  );
}
