import React from "react";
import { Link } from "wouter";

/** Avery's morning brief in chat: the top three, each with its button, and the day's counts. */

export type BriefItem = { key: string; title: string; body: string; button: string; link: string | null; decisionKey: string | null };

export function AveryBriefCard({ items, counts }: { items: BriefItem[]; counts?: { decisions: number; meetings: number; waiting: number; handled: number } }) {
  const work = "/chats/inbox/work";
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 0 }}>
      {items.length === 0 && <span style={{ fontSize: 14, padding: "6px 0" }}>Nothing needs you right now.</span>}
      {items.map((x, i) => (
        <div key={x.key} className="ld-desk-top" style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr) 128px", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: i < items.length - 1 ? "1px solid #eef2f0" : 0, fontSize: 15, lineHeight: 1.5 }}>
          <span aria-hidden style={{ width: 26, height: 26, borderRadius: 999, background: "#e6f2ec", color: "#155c3e", fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
          <span>
            <b>{x.title}</b> {x.body}
          </span>
          {x.button === "Decide" && x.decisionKey ? (
            <Link href={`${work}?tab=decisions&d=${encodeURIComponent(x.decisionKey)}`} className="ld-btn p">Decide</Link>
          ) : x.link ? (
            <Link href={x.link} className="ld-btn">{x.button}</Link>
          ) : (
            <span />
          )}
        </div>
      ))}
      {counts && (
        <div className="ld-small" style={{ color: "#5b6b64", paddingTop: 8, borderTop: "1px solid #eef2f0", marginTop: 4 }}>
          {counts.decisions} decision{counts.decisions === 1 ? "" : "s"} · {counts.meetings} meeting{counts.meetings === 1 ? "" : "s"} · {counts.waiting} waiting · {counts.handled} handled
        </div>
      )}
    </div>
  );
}
