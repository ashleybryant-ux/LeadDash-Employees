import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { uploadFile } from "../meta";

/**
 * The Brain's Import history tab: upload a Claude or ChatGPT data export, watch
 * it being read, and see every fact it saved (with Remove for any that are wrong).
 */

const COLS = "minmax(0,1fr) minmax(0,2fr) 160px 128px";
const SOURCE: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", unknown: "Reading" };

export default function BrainImport() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.history.latest.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: (r) => (r.state.data && ["reading", "running"].includes(r.state.data.status) ? 4000 : false) });
  const stop = trpc.history.stop.useMutation({ onSuccess: () => utils.history.latest.invalidate() });
  const remove = trpc.history.removeFact.useMutation({ onSuccess: () => Promise.all([utils.history.latest.invalidate(), utils.knowledge.invalidate()]) });
  const [uploading, setUploading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [also, setAlso] = React.useState<string[]>([]);
  const file = React.useRef<HTMLInputElement>(null);
  const imp = q.data;
  const live = !!imp && ["reading", "running"].includes(imp.status);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setUploading(true);
    try {
      const r = (await uploadFile("history", f, { organizationId: currentOrgId })) as { also?: string[] };
      setAlso(r.also ?? []);
      await utils.history.latest.invalidate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
    }
  };

  const pct = imp && imp.total ? Math.round((imp.done / imp.total) * 100) : 0;
  const status = !imp
    ? ""
    : imp.status === "reading"
      ? "Opening the file"
      : imp.status === "running"
        ? `Read ${imp.done} of ${imp.total} chats`
        : imp.status === "done"
          ? `Finished: read all ${imp.total} chats`
          : imp.status === "stopped"
            ? `Stopped after ${imp.done} of ${imp.total} chats`
            : `Didn't finish: ${imp.error ?? "something went wrong"}`;

  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="ld-av-set" style={{ border: "1px solid #e3e9e6", borderRadius: 12, background: "#fff" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">Import from Claude or ChatGPT</span>
          {imp ? (
            <div className="ld-av-kv">
              <span className="ld-strong">File</span>
              <span style={{ overflowWrap: "anywhere" }}>{imp.fileName}{imp.source !== "unknown" ? ` · ${SOURCE[imp.source]}` : ""}{imp.total ? ` · ${imp.total} chats` : ""}</span>
              <span className="ld-strong">Progress</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                {live && (
                  <div className="ld-hi-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <div style={{ width: `${Math.max(3, pct)}%` }} />
                  </div>
                )}
                <span className={imp.status === "failed" ? "ld-small" : "ld-small ld-muted"} style={imp.status === "failed" ? { color: "#b42318" } : undefined}>{status}</span>
              </div>
              <span className="ld-strong">Saved to the Brain</span>
              <span>{imp.items.length} {imp.items.length === 1 ? "fact" : "facts"}</span>
              <span className="ld-strong">Left out</span>
              <span>{imp.skippedClient} with client details · {imp.skippedOther} not about the business</span>
              {also.length > 0 && (
                <>
                  <span className="ld-strong">Also importing</span>
                  <span>{also.join(", ")}</span>
                </>
              )}
            </div>
          ) : (
            <div className="ld-av-kv">
              <span className="ld-strong">Claude</span>
              <span>Settings, Privacy, Export data. Upload the .zip or the manifest .json Claude sends, within 24 hours.</span>
              <span className="ld-strong">ChatGPT</span>
              <span>Settings, Data controls, Export data. ChatGPT emails you a .zip.</span>
            </div>
          )}
          <ErrorLine error={err ? { message: err } : stop.error ?? remove.error} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input ref={file} type="file" accept=".zip,.json,application/zip,application/json" className="ld-sr" id="history-file" onChange={(e) => void pick(e.target.files?.[0])} />
          {live ? (
            <button type="button" className="ld-btn" disabled={stop.isPending} onClick={() => imp && stop.mutate({ organizationId: currentOrgId, id: imp.id })}>Stop</button>
          ) : (
            <button type="button" className="ld-btn p" disabled={uploading} onClick={() => file.current?.click()}>{uploading ? "Uploading..." : imp ? "Import another" : "Upload export"}</button>
          )}
        </div>
      </div>

      {imp && imp.items.length > 0 && (
        <div className="ld-card" style={{ overflow: "hidden" }}>
          <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
            <span>Topic</span>
            <span>Fact</span>
            <span>From</span>
            <span />
          </div>
          {imp.items.map((f) => (
            <div key={f.id} className="ld-rw" style={{ gridTemplateColumns: COLS, alignItems: "start" }}>
              <span className="ld-strong" style={{ overflowWrap: "anywhere" }}>{f.topic}</span>
              <span style={{ lineHeight: 1.5 }}>{f.fact}</span>
              <span className="ld-small" style={{ color: "#3d4c45" }}>{f.from}</span>
              <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: imp.id, knowledgeId: f.id })}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
