import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import { APP_STATUS, CHANNEL_LABEL, openDownload, parseJson, uploadFile, wordCount } from "../meta";
import type { AppDetail, Attachment, Extras, Question, Requirements, Review } from "../types";

const pageStyle: React.CSSProperties = { padding: "28px 36px", display: "flex", flexDirection: "column", gap: 20 };

function channelText(channel: string, detail: string | null) {
  if (channel === "email") return `Goes in by email${detail ? ` to ${detail}` : ""}`;
  if (channel === "portal") return `Goes in through ${detail || "the host's portal"}`;
  if (channel === "form") return "Goes in through the host's online form";
  return `Goes in through ${CHANNEL_LABEL[channel] ?? channel}`;
}

/** One application: the host's questions with answers, attachments, checks, and Submit. */
export default function ApplicationPage({ emp, appId, view }: { emp: EmployeeRow; appId: number; view: "main" | "review" }) {
  const { currentOrgId } = useTenant();
  const base = `/chats/${emp.kind}`;
  const q = trpc.applications.get.useQuery(
    { organizationId: currentOrgId, id: appId },
    { refetchInterval: (query) => (query.state.data?.app.status === "writing" ? 4000 : false) }
  );
  if (q.isLoading) return <main className="ld-main" style={pageStyle}><div className="ld-empty">Loading...</div></main>;
  if (!q.data) return <main className="ld-main" style={pageStyle}><ErrorLine error={q.error} /></main>;
  return view === "review" ? <ReviewView d={q.data} base={base} /> : <MainView d={q.data} emp={emp} base={base} />;
}

function Header({ d, base, back, backHref, right }: { d: AppDetail; base: string; back: string; backHref: string; right?: React.ReactNode }) {
  const { app, opp } = d;
  const st = APP_STATUS[app.status] ?? { label: app.status, cls: "gray" };
  return (
    <>
      <Link href={backHref} style={{ fontSize: 13, fontWeight: 700 }}>{back}</Link>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{app.title}</h1>
            <span className={`ld-pill ${st.cls}`}>{app.status === "writing" && app.progress ? app.progress : app.mode === "outline" && app.status === "ready" ? "You write" : st.label}</span>
          </div>
          <span className="ld-body" style={{ color: "#3d4c45" }}>
            {[opp?.host, opp?.amount, opp?.deadline && `Due ${opp.deadline}`, channelText(app.channel, app.channelDetail)].filter(Boolean).join(" · ")}
          </span>
        </div>
        {right}
      </div>
    </>
  );
}

function CheckLine({ ok, text, note }: { ok: boolean; text: string; note?: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 8, alignItems: "start" }}>
      <span aria-hidden="true" style={{ fontWeight: 800, color: ok ? "#1f7a4d" : "#b4610e" }}>{ok ? "✓" : "!"}</span>
      <span className="ld-body">
        {text}
        <span className="ld-sr">{ok ? " (done)" : " (needs you)"}</span>
        {note && <span className="ld-small ld-muted" style={{ display: "block" }}>{note}</span>}
      </span>
    </div>
  );
}

function MainView({ d, emp, base }: { d: AppDetail; emp: EmployeeRow; base: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const { app, opp } = d;
  const reqs = parseJson<Requirements>(opp?.requirements, {});
  const qs = parseJson<Question[]>(app.questions, []);
  const atts = parseJson<Attachment[]>(app.attachments, []);
  const extras = parseJson<Extras>(app.extras, {});
  const review = parseJson<Review | null>(app.review, null);
  const refresh = () => Promise.all([utils.applications.get.invalidate(), utils.applications.list.invalidate()]);
  const submit = trpc.applications.submit.useMutation({ onSuccess: refresh });
  const rewrite = trpc.applications.rewrite.useMutation({ onSuccess: refresh });
  const sendNow = trpc.applications.sendNow.useMutation({ onSuccess: refresh });
  const dl = trpc.applications.download.useMutation({ onSuccess: openDownload });
  const sigs = atts.filter((a) => a.needsSignature);
  const done = ["approved", "submitted", "awarded", "declined"].includes(app.status);
  const signer = d.signer.name ? `${d.signer.name}${d.signer.title ? `, ${d.signer.title}` : ""}` : null;

  return (
    <main className="ld-main" style={pageStyle}>
      <Header
        d={d}
        base={base}
        back="Applications"
        backHref={`${base}/work?tab=applications`}
        right={
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
            <div className="ld-row">
              <button type="button" className="ld-btn" disabled={dl.isPending} onClick={() => dl.mutate({ organizationId: currentOrgId, id: app.id, what: "zip" })}>Download</button>
              {!done && (
                <button type="button" className="ld-btn p" disabled={submit.isPending || d.blockers.length > 0} onClick={() => submit.mutate({ organizationId: currentOrgId, id: app.id })}>
                  Approve
                </button>
              )}
            </div>
          </div>
        }
      />

      {!done && d.blockers.length === 0 && (
        <span className="ld-small ld-muted">
          Approving certifies the application is true and complete and that you are authorized to submit it for {d.signer.org}.{signer ? ` Signed by ${signer}.` : ""}
        </span>
      )}
      {(!done || app.status === "approved") && app.status !== "writing" && (
        <div className="ld-card" style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="ld-lbl">Before it goes in</span>
            <CheckLine ok={d.sending.route.ready} text={d.sending.route.label} note={d.sending.route.detail} />
            {d.blockers.filter((b) => !(sigs.length && /signature/i.test(b))).map((b) => (
              <CheckLine key={b} ok={false} text={b} />
            ))}
            {sigs.map((a) => (
              <CheckLine key={a.name} ok={Boolean(a.fileUrl)} text={a.fileUrl ? `${a.name} signed and uploaded` : `${a.name} needs your signature, then upload it`} />
            ))}
            {app.status === "approved" && (
              <span className="ld-small ld-muted">
                Approved by {app.certifiedBy}.{" "}
                {d.sending.route.ready
                  ? `${emp.name} is sending it and posts the confirmation in Chat. If it stopped, press Send now to try again.`
                  : <>Download it, submit it on {opp?.sourceUrl ? <a href={opp.sourceUrl} target="_blank" rel="noreferrer noopener">the {opp?.kind === "bid" ? "agency's" : "host's"} page</a> : `the ${opp?.kind === "bid" ? "agency's" : "host's"} page`}, then press Mark sent on the Applications tab.</>}
              </span>
            )}
            {!done && <span className="ld-small ld-muted">{d.sending.route.ready ? `After you approve, ${emp.name} sends it and posts the confirmation in Chat.` : `After you approve, it's ready for you to send.`}</span>}
          </div>
          {app.status === "approved" && d.sending.route.ready && (
            <button type="button" className="ld-btn p" disabled={sendNow.isPending || sendNow.isSuccess} onClick={() => sendNow.mutate({ organizationId: currentOrgId, id: app.id })}>
              {sendNow.isPending ? "Sending..." : sendNow.isSuccess ? "Sending" : "Send now"}
            </button>
          )}
        </div>
      )}
      <ErrorLine error={submit.error || dl.error || rewrite.error || sendNow.error} />

      {app.status === "writing" && (
        <div className="ld-card ld-row" style={{ padding: "12px 16px", gap: 12 }}>
          <span className="ld-dots" aria-hidden="true"><span /><span /><span /></span>
          <span className="ld-body">{app.progress || "Working"}. This page updates on its own.</span>
        </div>
      )}
      {app.status === "error" && (
        <div className="ld-card" style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 12, alignItems: "center", borderColor: "#f3c7c1" }}>
          <span className="ld-body" style={{ color: "#b42318" }}>{app.errorNote || "Something went wrong."}</span>
          <button type="button" className="ld-btn p" disabled={rewrite.isPending} onClick={() => rewrite.mutate({ organizationId: currentOrgId, id: app.id })}>Write again</button>
        </div>
      )}
      {app.mode === "outline" && (
        <div style={{ background: "#fdf0e3", border: "1px solid #f3d3b0", borderRadius: 12, padding: "14px 18px" }}>
          <span className="ld-body" style={{ color: "#5c2e0a" }}>
            <strong>AI rule.</strong> {(reqs.aiPolicy?.note || "This host limits AI-written applications").replace(/\.$/, "")}{reqs.aiPolicy?.citation ? ` (${reqs.aiPolicy.citation})` : ""}. {emp.name} prepared the outline, facts and sources. You write each section.
          </span>
        </div>
      )}

      {d.questions.length > 0 && <AskCards list={d.questions} onDone={refresh} />}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">{opp?.kind === "speaking" ? "The organizer's questions" : "The host's questions"} ({qs.length})</span>
          {qs.length === 0 && <div className="ld-card ld-empty">{app.status === "writing" ? "Reading the host's package..." : "No questions yet."}</div>}
          {qs.map((qq, i) => (
            <QuestionCard key={qq.id} q={qq} n={i + 1} appId={app.id} outline={app.mode === "outline"} locked={done || app.status === "writing"} onSaved={refresh} />
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {review && (
            <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="ld-between">
                <span className="ld-lbl">Reviewer check</span>
                <span style={{ fontWeight: 800, fontSize: 18 }}>{review.score} <span className="ld-small ld-muted">of {review.total}</span></span>
              </div>
              <span className="ld-small ld-muted">{review.fixes.filter((f) => !f.done).length} to fix before submitting</span>
              <Link href={`${base}/app/${app.id}/review`} className="ld-btn" style={{ width: "100%" }}>Open check</Link>
            </div>
          )}

          {(extras.deck?.length || extras.videoScript) && <PitchCards appId={app.id} extras={extras} reqs={reqs} locked={done} onSaved={refresh} />}

          <div className="ld-card" style={{ padding: "14px 16px" }}>
            <span className="ld-lbl">Attachments</span>
            {atts.length === 0 && <p className="ld-small ld-muted" style={{ margin: "8px 0 0" }}>The host does not ask for any.</p>}
            {atts.map((a, i) => (
              <AttachmentRow key={a.name} a={a} last={i === atts.length - 1} appId={app.id} empName={emp.name} locked={done} onSaved={refresh} />
            ))}
          </div>

          <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="ld-lbl">Checked</span>
            {(reqs.eligibility || opp?.eligibility) && <span className="ld-body">Eligibility, on the host's page</span>}
            {(reqs.due || opp?.deadline) && <span className="ld-body">Deadline, {reqs.due || opp?.deadline}</span>}
            <span className="ld-body">{channelText(app.channel, app.channelDetail)}</span>
            {reqs.aiPolicy && !reqs.aiPolicy.restricted && <span className="ld-body">No AI rule in the host's documents</span>}
          </div>

          <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="ld-lbl">Sources</span>
            {opp?.sourceUrl && (
              <a href={opp.sourceUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>
                {opp.sourceUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
              </a>
            )}
            {d.files.map((f) =>
              f.fileUrl ? (
                <a key={f.id} href={f.fileUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{f.name}</a>
              ) : (
                <span key={f.id} className="ld-body">{f.name}</span>
              )
            )}
            {Array.from(new Set(qs.flatMap((x) => x.sources))).filter((s) => !d.files.some((f) => s.startsWith(f.name))).slice(0, 8).map((s) => (
              <span key={s} className="ld-small ld-muted">{s}</span>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

function AskCards({ list, onDone }: { list: AppDetail["questions"]; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const answer = trpc.applications.answer.useMutation({ onSuccess: onDone });
  return (
    <>
      {list.map((q) => (
        <div key={q.id} className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, borderColor: "#e8b98a" }}>
          <span className="ld-lbl">{q.label}</span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{q.question}</span>
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            {parseJson<string[]>(q.options, []).map((o) => (
              <button key={o} type="button" className="ld-sug" style={{ borderRadius: 9, height: 36, fontWeight: 700, color: "#14221c" }} disabled={answer.isPending} onClick={() => answer.mutate({ organizationId: currentOrgId, questionId: q.id, answer: o })}>
                {o}
              </button>
            ))}
          </div>
          <ErrorLine error={answer.error} />
        </div>
      ))}
    </>
  );
}

function QuestionCard({ q, n, appId, outline, locked, onSaved }: { q: Question; n: number; appId: number; outline: boolean; locked: boolean; onSaved: () => void }) {
  const { currentOrgId } = useTenant();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(q.answer);
  React.useEffect(() => { if (!editing) setText(q.answer); }, [q.answer, editing]);
  const save = trpc.applications.saveAnswer.useMutation({ onSuccess: () => { setEditing(false); onSaved(); } });
  const redo = trpc.applications.rewriteQuestion.useMutation({ onSuccess: (r) => { const nq = parseJson<Question[]>(r?.questions, []).find((x) => x.id === q.id); if (nq) setText(nq.answer); onSaved(); } });
  const used = wordCount(editing ? text : q.answer);
  const over = q.maxWords > 0 && used > q.maxWords;
  const limit = q.limit ? `${q.limit} · ${used} used` : used ? `${used} words` : "";

  return (
    <div className={`ld-card ${editing ? "editing" : ""}`} style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15, lineHeight: 1.4 }}>{n}. {q.text}</div>
        {limit && <span style={{ fontSize: 12, fontWeight: 600, color: over ? "#b42318" : "#5b6b64" }}>{limit}</span>}
        {outline && (q.outline.length > 0 || q.facts.length > 0) && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16 }}>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6, color: "#24332c" }}>
              {q.outline.map((o, i) => <li key={i}>{o}</li>)}
            </ul>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {q.facts.map((f, i) => (
                <span key={i} className="ld-small" style={{ color: "#3d4c45", lineHeight: 1.5 }}>{f.text} <span className="ld-muted">({f.source})</span></span>
              ))}
            </div>
          </div>
        )}
        {editing ? (
          <>
            <label className="ld-sr" htmlFor={`a-${q.id}`}>Answer to question {n}</label>
            <textarea id={`a-${q.id}`} className="ld-ta" rows={7} value={text} onChange={(e) => setText(e.target.value)} style={{ fontSize: 14, lineHeight: 1.55 }} />
            {!outline && (
              <div className="ld-row" style={{ flexWrap: "wrap" }}>
                <span className="ld-lbl" style={{ marginRight: 4 }}>Rewrite</span>
                <button type="button" className="ld-btn sm" disabled={redo.isPending} onClick={() => redo.mutate({ organizationId: currentOrgId, id: appId, questionId: q.id, style: "detailed" })}>Detailed</button>
                <button type="button" className="ld-btn sm" disabled={redo.isPending} onClick={() => redo.mutate({ organizationId: currentOrgId, id: appId, questionId: q.id, style: "concise" })}>Concise</button>
                {redo.isPending && <span className="ld-small ld-muted">Rewriting...</span>}
              </div>
            )}
            <ErrorLine error={save.error || redo.error} />
          </>
        ) : q.answer ? (
          <div style={{ fontSize: 14, lineHeight: 1.6, color: "#24332c", whiteSpace: "pre-line" }}>{q.answer}</div>
        ) : (
          <span className="ld-small ld-muted">{outline ? "Not written yet." : q.status === "writing" ? "Writing..." : "No answer yet."}</span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {editing ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: appId, questionId: q.id, answer: text })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          !locked && (
            <button type="button" className={`ld-btn ${outline && !q.answer ? "p" : ""}`} onClick={() => setEditing(true)}>
              {outline && !q.answer ? "Write" : "Edit"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function AttachmentRow({ a, last, appId, empName, locked, onSaved }: { a: Attachment; last: boolean; appId: number; empName: string; locked: boolean; onSaved: () => void }) {
  const { currentOrgId } = useTenant();
  const ref = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const pill =
    a.source === "brain" ? <span className="ld-pill green">From Brain</span>
    : a.source === "made" ? <span className="ld-pill green">{empName} made</span>
    : a.source === "upload" ? <span className="ld-pill green">Uploaded</span>
    : null;
  const needsUpload = !locked && (a.source === "missing" || (a.needsSignature && a.source !== "upload"));
  return (
    <div style={{ padding: "10px 0", borderBottom: last ? 0 : "1px solid #eef2f0", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, alignItems: "center", fontSize: 14 }}>
        {a.fileUrl ? <a href={a.fileUrl} target="_blank" rel="noreferrer noopener" className="ld-clip" style={{ fontWeight: 600 }}>{a.name}</a> : <span className="ld-clip">{a.name}</span>}
        {needsUpload ? (
          <>
            <input ref={ref} type="file" className="ld-sr" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setErr(null);
              setBusy(true);
              try { await uploadFile("attachment", f, { organizationId: currentOrgId, applicationId: appId, attachment: a.name }); onSaved(); } catch (er) { setErr((er as Error).message); } finally { setBusy(false); }
            }} />
            <button type="button" className="ld-btn sm" disabled={busy} onClick={() => ref.current?.click()}>{busy ? "Uploading" : "Upload"}</button>
          </>
        ) : pill}
      </div>
      {a.needsSignature && a.source !== "upload" && <span className="ld-small" style={{ color: "#8a4510" }}>Needs your signature. Sign the host's form and upload it.</span>}
      {a.source === "missing" && <span className="ld-small ld-muted">{a.required ? "Required" : "Optional"}. Not found in the Brain or Knowledge.</span>}
      {err && <span className="ld-small" style={{ color: "#b42318" }}>{err}</span>}
    </div>
  );
}

function PitchCards({ appId, extras, reqs, locked, onSaved }: { appId: number; extras: Extras; reqs: Requirements; locked: boolean; onSaved: () => void }) {
  const { currentOrgId } = useTenant();
  const dl = trpc.applications.download.useMutation({ onSuccess: openDownload });
  const [showScript, setShowScript] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const scriptWords = wordCount(extras.videoScript ?? "");
  const mins = Math.floor(scriptWords / 145);
  const secs = Math.round(((scriptWords / 145) % 1) * 60);
  return (
    <>
      {extras.deck && extras.deck.length > 0 && (
        <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="ld-between">
            <span className="ld-lbl">Deck ({extras.deck.length} slides)</span>
            <button type="button" className="ld-btn sm" disabled={dl.isPending} onClick={() => dl.mutate({ organizationId: currentOrgId, id: appId, what: "deck" })}>Download</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
            {extras.deck.slice(0, 6).map((s, i) => (
              <div key={i} style={{ aspectRatio: "16 / 9", borderRadius: 8, background: i === 0 ? "#0d3b2e" : "#24403a", color: "#fff", fontSize: 11, fontWeight: 700, padding: 8, boxSizing: "border-box", display: "flex", alignItems: "flex-end", lineHeight: 1.25, overflow: "hidden" }}>
                {s.title}
              </div>
            ))}
          </div>
        </div>
      )}
      {extras.videoScript && (
        <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="ld-between">
            <span className="ld-lbl">Video script</span>
            <span className="ld-small ld-muted">{mins}:{String(secs).padStart(2, "0")} · {scriptWords} words</span>
          </div>
          <div className="ld-small" style={{ color: "#24332c", lineHeight: 1.55, whiteSpace: "pre-line" }}>{showScript ? extras.videoScript : `${extras.videoScript.slice(0, 160)}${extras.videoScript.length > 160 ? "..." : ""}`}</div>
          <button type="button" className="ld-btn sm" onClick={() => setShowScript((v) => !v)}>{showScript ? "Close" : "Open"}</button>
        </div>
      )}
      <div className="ld-card" style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 10, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="ld-lbl">Your video</span>
          {extras.videoUrl ? (
            <a href={extras.videoUrl} target="_blank" rel="noreferrer noopener" className="ld-clip" style={{ fontSize: 14, fontWeight: 600 }}>{extras.videoName || "Video"}</a>
          ) : (
            <span className="ld-body">{reqs.videoRequired ? "Needed" : "Optional"}{reqs.videoLimit ? `, up to ${reqs.videoLimit}` : ""}</span>
          )}
        </div>
        {!locked && (
          <>
            <input ref={ref} type="file" accept="video/*" className="ld-sr" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setErr(null);
              setBusy(true);
              try { await uploadFile("video", f, { organizationId: currentOrgId, applicationId: appId }); onSaved(); } catch (er) { setErr((er as Error).message); } finally { setBusy(false); }
            }} />
            <button type="button" className={`ld-btn sm ${extras.videoUrl ? "" : "p"}`} disabled={busy} onClick={() => ref.current?.click()}>{busy ? "Uploading" : extras.videoUrl ? "Replace" : "Upload"}</button>
          </>
        )}
        {err && <span className="ld-small" style={{ color: "#b42318", gridColumn: "1 / -1" }}>{err}</span>}
      </div>
      {extras.financials && (
        <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="ld-lbl">Financial summary</span>
          <span className="ld-small" style={{ whiteSpace: "pre-line", lineHeight: 1.55 }}>{extras.financials}</span>
        </div>
      )}
      <ErrorLine error={dl.error} />
    </>
  );
}

// ==========================================
// Reviewer check
// ==========================================

function ReviewView({ d, base }: { d: AppDetail; base: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const { app, opp } = d;
  const reqs = parseJson<Requirements>(opp?.requirements, {});
  const review = parseJson<Review | null>(app.review, null);
  const refresh = () => Promise.all([utils.applications.get.invalidate(), utils.applications.list.invalidate()]);
  const check = trpc.applications.review.useMutation({ onSuccess: refresh });
  const fix = trpc.applications.fix.useMutation({ onSuccess: refresh });
  const open = review?.fixes.filter((f) => !f.done) ?? [];

  return (
    <main className="ld-main" style={pageStyle}>
      <Link href={`${base}/app/${app.id}`} style={{ fontSize: 13, fontWeight: 700 }}>{app.title}</Link>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Reviewer check</h1>
          <span className="ld-body" style={{ color: "#3d4c45" }}>
            Scored against {reqs.scoring?.length ? `the host's rubric${reqs.pages?.scoring ? ` (${reqs.pages.scoring})` : ""}` : "a standard rubric"} by a reviewer that did not write the application
          </span>
        </div>
        <button type="button" className="ld-btn" disabled={check.isPending} onClick={() => check.mutate({ organizationId: currentOrgId, id: app.id })}>{check.isPending ? "Checking..." : "Check again"}</button>
      </div>
      <ErrorLine error={check.error || fix.error} />
      {!review ? (
        <div className="ld-card ld-empty">No check yet. Press Check again.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 20, alignItems: "start" }}>
          <div className="ld-card" style={{ overflow: "hidden" }}>
            <div className="ld-between" style={{ padding: "16px 18px", borderBottom: "1px solid #e3e9e6", alignItems: "baseline" }}>
              <span className="ld-lbl">Estimated score</span>
              <span style={{ fontSize: 28, fontWeight: 800 }}>{review.score} <span style={{ fontSize: 15, color: "#5b6b64", fontWeight: 700 }}>of {review.total}</span></span>
            </div>
            {review.criteria.map((c, i) => {
              const pct = c.max ? Math.round((c.points / c.max) * 100) : 0;
              return (
                <div key={c.name} style={{ padding: "12px 18px", borderBottom: i === review.criteria.length - 1 ? 0 : "1px solid #eef2f0", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) 90px minmax(0,2fr)", gap: 16, alignItems: "center", fontSize: 14 }}>
                    <span className="ld-strong">{c.name}</span>
                    <span>{c.points} of {c.max}</span>
                    <div style={{ height: 8, borderRadius: 999, background: "#e3e9e6", overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${pct}%`, background: pct < 75 ? "#c2410c" : "#1b6b4a" }} /></div>
                  </div>
                  {c.note && <span className="ld-small ld-muted">{c.note}</span>}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="ld-card" style={{ overflow: "hidden" }}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid #e3e9e6" }}><span className="ld-lbl">Fix before submitting ({open.length})</span></div>
              {open.length === 0 && <div className="ld-empty">Nothing left to fix.</div>}
              {open.map((f, i) => {
                const needsYou = f.kind === "attachment" || f.kind === "video";
                return (
                  <div key={f.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, padding: "14px 18px", alignItems: "center", fontSize: 14, borderBottom: i === open.length - 1 ? 0 : "1px solid #eef2f0" }}>
                    <span>{f.text}</span>
                    {needsYou ? (
                      <Link href={`${base}/app/${app.id}`} className="ld-btn">Upload</Link>
                    ) : (
                      <button type="button" className="ld-btn p" disabled={fix.isPending} onClick={() => fix.mutate({ organizationId: currentOrgId, id: app.id, fixId: f.id })}>
                        {fix.isPending && fix.variables?.fixId === f.id ? "Fixing..." : "Fix"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {review.passed.length > 0 && (
              <div className="ld-card" style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="ld-lbl">Passed</span>
                {review.passed.map((p) => <span key={p} className="ld-body">{p}</span>)}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
