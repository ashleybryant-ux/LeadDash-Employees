import React from "react";
import { Link, useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ChatList, ErrorLine, Rail, BottomNav } from "../ui";
import { Message } from "../team/Message";
import { useNamesFor } from "../TeamChat";

/**
 * Search across channels, threads, direct messages and files, with From, In,
 * Has files and Date filters. A result opens in its channel at that message.
 */

const DATES = [
  { v: "", label: "Any time" },
  { v: "7", label: "Last 7 days" },
  { v: "30", label: "Last 30 days" },
  { v: "90", label: "Last 90 days" },
  { v: "365", label: "Last year" },
];

export default function TeamSearchPage() {
  const { currentOrgId } = useTenant();
  const [, go] = useLocation();
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const q = sp.get("q") ?? "";
  const from = Number(sp.get("from")) || null;
  const inKey = sp.get("in") || null;
  const files = sp.get("files") === "1";
  const days = Number(sp.get("days")) || null;
  const [draft, setDraft] = React.useState(q);
  React.useEffect(() => setDraft(q), [q]);

  const chans = trpc.teamChat.channels.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const general = trpc.teamChat.messages.useQuery({ organizationId: currentOrgId, channel: "everyone" }, { enabled: currentOrgId > 0 });
  const r = trpc.teamChat.search.useQuery({ organizationId: currentOrgId, q, from, in: inKey, files, days }, { enabled: currentOrgId > 0 && (!!q.trim() || files || !!from) });
  const channelNames = React.useMemo(() => (chans.data?.channels ?? []).map((c) => ({ name: c.name, key: c.key })), [chans.data]);
  const base = useNamesFor(general.data, channelNames);
  const names = React.useMemo(() => ({ ...base.names, mark: q.toLowerCase().split(/\s+/).filter(Boolean) }), [base.names, q]);
  const who = base.who;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    go(`/chats/search${s ? `?${s}` : ""}`, { replace: true });
  };
  const people = general.data?.people ?? [];
  const hits = r.data?.hits ?? [];
  const where = (h: (typeof hits)[number]) => (h.dm ? `Direct message · ${h.channelName}` : `# ${h.channelName}${h.threadOf ? " · thread" : ""}`);

  return (
    <div className="ld has-emp">
      <Rail active="chats" />
      <ChatList activeKind="team:search" />
      <section className="ld-chatmain tc-main" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <header className="ld-emphead tc-head2">
          <Link href="/chats?list=1" className="ld-mobile-only" aria-label="Back to chats" style={{ color: "var(--ld-ink)", display: "flex" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </Link>
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25, minWidth: 0 }}>
            <b style={{ fontSize: 16 }}>Search</b>
            <span className="ld-small ld-muted">Messages, threads, direct messages and files in this workspace</span>
          </span>
        </header>
        <div className="tc-page">
          <form
            className="tc-searchbox"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: draft.trim() });
            }}
          >
            <input className="ld-in lg" autoFocus value={draft} placeholder="Search messages, people, files" aria-label="Search" onChange={(e) => setDraft(e.target.value)} />
            <button type="submit" className="ld-btn p sm">Search</button>
            {r.data && <span className="ld-small ld-muted" style={{ whiteSpace: "nowrap" }}>{hits.length} {hits.length === 1 ? "result" : "results"}</span>}
          </form>
          <div className="tc-filters">
            <label className="tc-fil">
              From
              <select className="ld-in" value={from ?? ""} onChange={(e) => set({ from: e.target.value })} aria-label="From">
                <option value="">anyone</option>
                {people.map((p) => (
                  <option key={p.userId} value={p.userId}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="tc-fil">
              In
              <select className="ld-in" value={inKey ?? ""} onChange={(e) => set({ in: e.target.value })} aria-label="In">
                <option value="">anywhere</option>
                {(chans.data?.channels ?? []).map((c) => (
                  <option key={c.key} value={c.key}>#{c.name}</option>
                ))}
                {(chans.data?.dms ?? []).map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="tc-fil check">
              <input type="checkbox" checked={files} onChange={(e) => set({ files: e.target.checked ? "1" : null })} /> Has files
            </label>
            <label className="tc-fil">
              Date
              <select className="ld-in" value={days ?? ""} onChange={(e) => set({ days: e.target.value })} aria-label="Date">
                {DATES.map((o) => (
                  <option key={o.v} value={o.v}>{o.label}</option>
                ))}
              </select>
            </label>
          </div>
          <ErrorLine error={r.error} />
          {r.isFetching && !r.data && <p className="ld-muted">Searching</p>}
          {r.data && !hits.length && <p className="ld-muted">Nothing matches. Try fewer words, or clear a filter.</p>}
          {!r.data && !r.isFetching && <p className="ld-muted">Type what you remember and press Enter.</p>}
          <div className="tc-hits">
            {hits.map((h) => (
              <div key={h.id} className="tc-hit">
                <div className="ld-between">
                  <span className="ld-small ld-muted" style={{ fontWeight: 700 }}>{where(h)} · {new Date(h.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                  <Link href={`/chats/team/${h.channel}?${h.threadOf ? `thread=${h.threadOf}` : `at=${h.id}`}`} className="gp-link" style={{ fontWeight: 700, whiteSpace: "nowrap" }}>Open in {h.dm ? "the conversation" : "channel"} →</Link>
                </div>
                <Message m={h} people={people} employees={general.data?.employees ?? []} names={names} who={who} admin={!!chans.data?.admin} compact inThread />
              </div>
            ))}
          </div>
        </div>
      </section>
      <BottomNav active="chats" />
    </div>
  );
}
