import React from "react";
import { Link } from "wouter";

/**
 * Team chat message text: **bold**, _italic_, ~strike~, `code`, links,
 * "> " quotes, "- " and "1. " lists, @mentions of people and AI employees,
 * and #channel names that open the channel.
 */

export type Names = { people: string[]; employees: string[]; channels: { name: string; key: string }[]; mark?: string[] };

const URL_RE = /(https?:\/\/[^\s<>)]+[^\s<>).,!?;:'"])/g;

function inline(text: string, names: Names, key: string): React.ReactNode[] {
  // Split on code first so nothing inside it is styled.
  const out: React.ReactNode[] = [];
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((p, i) => {
    if (/^`[^`]+`$/.test(p)) out.push(<code key={`${key}c${i}`}>{p.slice(1, -1)}</code>);
    else out.push(...styled(p, names, `${key}s${i}`));
  });
  return out;
}

function styled(text: string, names: Names, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|(?:^|(?<=\s))_([^_\n]+)_(?=\s|[.,!?;:]|$)|~([^~\n]+)~/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...plain(text.slice(last, m.index), names, `${key}p${n++}`));
    if (m[1] != null) out.push(<strong key={`${key}b${n++}`}>{plain(m[1], names, `${key}bi${n}`)}</strong>);
    else if (m[2] != null) out.push(<em key={`${key}i${n++}`}>{plain(m[2], names, `${key}ii${n}`)}</em>);
    else if (m[3] != null) out.push(<s key={`${key}x${n++}`}>{plain(m[3], names, `${key}xi${n}`)}</s>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...plain(text.slice(last), names, `${key}e`));
  return out;
}

/** Links, @mentions and #channels in otherwise plain text. */
function plain(text: string, names: Names, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const mentionNames = [...names.people, ...names.employees].filter(Boolean).sort((a, b) => b.length - a.length);
  const chans = names.channels.slice().sort((a, b) => b.name.length - a.name.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alts = [URL_RE.source];
  if (mentionNames.length) alts.push(`@(?:${mentionNames.map(esc).join("|")})(?![A-Za-z0-9])`);
  if (chans.length) alts.push(`#(?:${chans.map((c) => esc(c.name)).join("|")})(?![A-Za-z0-9-])`);
  const re = new RegExp(alts.join("|"), "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...marked(text.slice(last, m.index), names.mark, `${key}t${n++}`));
    const hit = m[0];
    if (hit.startsWith("http")) out.push(<a key={`${key}u${n++}`} href={hit} target="_blank" rel="noreferrer noopener">{hit}</a>);
    else if (hit.startsWith("@")) out.push(<span key={`${key}m${n++}`} className={`tc-mention ${names.employees.includes(hit.slice(1)) ? "ai" : ""}`}>{hit}</span>);
    else {
      const c = chans.find((x) => `#${x.name}` === hit);
      out.push(c ? <Link key={`${key}h${n++}`} href={`/chats/team/${c.key}`} className="tc-mention">{hit}</Link> : hit);
    }
    last = m.index + hit.length;
  }
  if (last < text.length) out.push(...marked(text.slice(last), names.mark, `${key}z`));
  return out;
}

/** Search words shown highlighted. */
function marked(text: string, words: string[] | undefined, key: string): React.ReactNode[] {
  const ws = (words ?? []).map((w) => w.trim()).filter(Boolean);
  if (!ws.length) return [text];
  const re = new RegExp(`(${ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={`${key}${i}`}>{part}</mark> : part));
}

export function TeamText({ text, names }: { text: string; names: Names }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let prevText = false;
  while (i < lines.length) {
    const line = lines[i];
    if (/^>\s?/.test(line)) {
      prevText = false;
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i].replace(/^>\s?/, "")), i++;
      blocks.push(<blockquote key={`q${i}`}>{q.map((l, j) => <div key={j}>{inline(l, names, `q${i}${j}`)}</div>)}</blockquote>);
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      prevText = false;
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i])) items.push(lines[i].replace(/^[-*•]\s+/, "")), i++;
      blocks.push(<ul key={`u${i}`}>{items.map((l, j) => <li key={j}>{inline(l, names, `u${i}${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      prevText = false;
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) items.push(lines[i].replace(/^\d+[.)]\s+/, "")), i++;
      blocks.push(<ol key={`o${i}`}>{items.map((l, j) => <li key={j}>{inline(l, names, `o${i}${j}`)}</li>)}</ol>);
      continue;
    }
    blocks.push(<React.Fragment key={`l${i}`}>{prevText ? <br /> : null}{inline(line, names, `l${i}`)}</React.Fragment>);
    prevText = true;
    i++;
  }
  return <div className="tc-text">{blocks}</div>;
}
