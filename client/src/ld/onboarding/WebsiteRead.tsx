import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";

/**
 * Read my website: type the address, the team reads the site and lists what
 * it found with the page each fact came from, next to what the Brain has
 * now. Tick what to keep and press Use these; nothing is saved before that.
 */
export function WebsiteRead({ website, onSaved, onClose }: { website: string; onSaved: () => Promise<unknown> | void; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [url, setUrl] = React.useState(website);
  const [keep, setKeep] = React.useState<Record<string, boolean>>({});
  const read = trpc.knowledge.readWebsite.useMutation({
    onSuccess: (r) => setKeep(Object.fromEntries(r.found.map((f) => [f.key, true]))),
  });
  const apply = trpc.knowledge.applyWebsite.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.knowledge.list.invalidate(), utils.onboarding.get.invalidate()]);
      await onSaved();
      onClose();
    },
  });
  const r = read.data;
  const chosen = r ? r.found.filter((f) => keep[f.key]) : [];
  const host = (u: string) => {
    try {
      return new URL(u).pathname.replace(/\/$/, "") || "/";
    } catch {
      return u;
    }
  };
  return (
    <div className="ld-card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
      <span className="ld-st">Read my website</span>
      {!r && (
        <>
          <span className="ld-small ld-muted">Type the address and the team reads the site: what you do, who you serve, services, booking link, contact details, brand colors, how it sounds and the team. You pick what to keep.</span>
          <form
            className="ld-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) read.mutate({ organizationId: currentOrgId, url: url.trim() });
            }}
          >
            <input className="ld-in" aria-label="Website address" placeholder="https://" value={url} style={{ maxWidth: 420 }} onChange={(e) => setUrl(e.target.value)} />
            <button type="submit" className="ld-btn p" disabled={read.isPending || !url.trim()}>{read.isPending ? "Reading" : "Read it"}</button>
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
          </form>
          {read.isPending && <span className="ld-small ld-muted">Reading the pages. This takes about a minute.</span>}
        </>
      )}
      {r && (
        <>
          <span className="ld-small ld-muted">
            I read {r.pages.length} {r.pages.length === 1 ? "page" : "pages"} on {r.website}. {r.found.length ? "Here is what I found. Untick anything you do not want kept." : "I could not find the business facts on it. Type them in instead."}
          </span>
          {r.found.map((f) => (
            <label key={f.key} className="ld-row" style={{ alignItems: "flex-start", gap: 12, padding: "8px 0", borderTop: "1px solid var(--ld-line2)", cursor: "pointer" }}>
              <input type="checkbox" style={{ marginTop: 4, accentColor: "var(--ld-accent)" }} checked={!!keep[f.key]} onChange={(e) => setKeep({ ...keep, [f.key]: e.target.checked })} />
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <span className="ld-strong" style={{ fontSize: 14 }}>{f.label}</span>
                <span style={{ fontSize: 14, overflowWrap: "anywhere" }}>{f.value}</span>
                <span className="ld-small ld-muted">From {host(f.source)} · saved to the {f.where}{f.current ? ` · replaces: ${f.current.slice(0, 140)}${f.current.length > 140 ? "..." : ""}` : ""}</span>
              </span>
            </label>
          ))}
          <div className="ld-row" style={{ gap: 8, paddingTop: 4 }}>
            <button type="button" className="ld-btn p" disabled={apply.isPending || !chosen.length} onClick={() => apply.mutate({ organizationId: currentOrgId, website: r.website, keep: Object.fromEntries(chosen.map((f) => [f.key, f.value])) })}>
              {apply.isPending ? "Saving" : chosen.length ? `Use these ${chosen.length}` : "Use these"}
            </button>
            <button type="button" className="ld-btn" onClick={() => read.reset()}>Read another address</button>
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
      <ErrorLine error={read.error || apply.error} />
    </div>
  );
}
