import React from "react";
import { Avatar, PersonAvatar } from "../ui";

/**
 * The message box: formatting (bold, italic, strike, code, link, lists,
 * quote), attachments, an emoji picker, and @mention autocomplete for people
 * and AI employees. Enter sends; Shift+Enter makes a new line.
 */

export type Mentionable = { people: { userId: number; name: string; avatarUrl: string | null }[]; employees: { id: number; name: string; roleTitle: string; kind: string; avatar: string | null }[] };

export const EMOJIS = ["👍", "✅", "🎉", "😊", "❤️", "🙏", "👏", "🔥", "👀", "😂", "🙌", "💯", "🤔", "😮", "😢", "👋", "💪", "⭐", "📌", "📝", "☕", "🎂", "🚀", "✨"];

export function EmojiPicker({ onPick, onClose, align = "left" }: { onPick: (e: string) => void; onClose: () => void; align?: "left" | "right" }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="tc-emojis" role="dialog" aria-label="Pick an emoji" style={align === "right" ? { right: 0 } : { left: 0 }}>
      {EMOJIS.map((e) => (
        <button key={e} type="button" onClick={() => onPick(e)} aria-label={e}>{e}</button>
      ))}
    </div>
  );
}

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  who: Mentionable;
  disabled?: boolean;
  busy?: boolean;
  sendLabel?: string;
  attach?: React.ReactNode;
  chips?: React.ReactNode;
  note?: string | null;
  extra?: React.ReactNode;
  compact?: boolean;
  autoFocus?: boolean;
  onCancel?: () => void;
  /** What tagging an AI employee does here; the team chat default is a thread answer. */
  employeeNote?: string;
  /** Pasted text longer than this many characters goes to onLongPaste (attached as a file) instead of the box. */
  longPaste?: { over: number; onPaste: (text: string) => void };
};

export function Composer({ value, onChange, onSend, placeholder, who, disabled, busy, sendLabel = "Send", attach, chips, note, extra, compact, autoFocus, onCancel, employeeNote = "AI employee, answers in a thread", longPaste }: Props) {
  const ta = React.useRef<HTMLTextAreaElement>(null);
  const [emoji, setEmoji] = React.useState(false);
  const [mention, setMention] = React.useState<{ at: number; q: string } | null>(null);
  const [pick, setPick] = React.useState(0);

  // Wrap the selection (or insert a mark at the caret).
  const wrap = (before: string, after = before, placeholderText = "text") => {
    const el = ta.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const sel = value.slice(s, e) || placeholderText;
    const next = value.slice(0, s) + before + sel + after + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, s + before.length + sel.length);
    });
  };
  const linePrefix = (prefix: (n: number) => string) => {
    const el = ta.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const start = value.lastIndexOf("\n", s - 1) + 1;
    const endIdx = value.indexOf("\n", e);
    const end = endIdx === -1 ? value.length : endIdx;
    const lines = value.slice(start, end).split("\n");
    const changed = lines.map((l, i) => prefix(i + 1) + l).join("\n");
    onChange(value.slice(0, start) + changed + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start, start + changed.length);
    });
  };
  const insert = (text: string) => {
    const el = ta.current;
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, s) + text + value.slice(e));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(s + text.length, s + text.length);
    });
  };

  const options = React.useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    const people = who.people.filter((p) => p.name.toLowerCase().includes(q)).map((p) => ({ key: `u${p.userId}`, name: p.name, sub: "", node: <PersonAvatar name={p.name} src={p.avatarUrl} size={24} /> }));
    const emps = who.employees.filter((e) => e.name.toLowerCase().includes(q)).map((e) => ({ key: `e${e.id}`, name: e.name, sub: `${e.roleTitle} · ${employeeNote}`, node: <Avatar name={e.name} kind={e.kind} src={e.avatar} size={24} /> }));
    return [...emps, ...people].slice(0, 8);
  }, [mention, who, employeeNote]);

  const choose = (name: string) => {
    if (!mention) return;
    const el = ta.current;
    const caret = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, mention.at)}@${name} ${value.slice(caret)}`;
    onChange(next);
    setMention(null);
    const pos = mention.at + name.length + 2;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const onInput = (v: string, caret: number) => {
    onChange(v);
    const before = v.slice(0, caret);
    const m = /(?:^|\s)@([^\s@]*(?: [^\s@]*)?)$/.exec(before);
    if (m && (who.people.length || who.employees.length)) {
      setMention({ at: caret - m[1].length - 1, q: m[1] });
      setPick(0);
    } else setMention(null);
  };

  const keyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && options.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPick((p) => (p + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPick((p) => (p - 1 + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(options[pick].name);
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      wrap("**");
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
      e.preventDefault();
      wrap("_");
    }
  };

  const fmt = (label: React.ReactNode, title: string, fn: () => void) => (
    <button type="button" title={title} aria-label={title} onClick={fn} tabIndex={-1}>
      {label}
    </button>
  );

  return (
    <div className={`tc-comp ${compact ? "compact" : ""}`} onDragOver={(e) => e.preventDefault()}>
      {!compact && (
        <div className="tc-fmt">
          {fmt(<b>B</b>, "Bold", () => wrap("**"))}
          {fmt(<i>I</i>, "Italic", () => wrap("_"))}
          {fmt(<s>S</s>, "Strikethrough", () => wrap("~"))}
          {fmt(<span style={{ fontFamily: "monospace" }}>{"<>"}</span>, "Code", () => wrap("`"))}
          {fmt("🔗", "Link", () => wrap("", " (https://)", "link text"))}
          {fmt("•≡", "Bulleted list", () => linePrefix(() => "- "))}
          {fmt("1.", "Numbered list", () => linePrefix((n) => `${n}. `))}
          {fmt("❝", "Quote", () => linePrefix(() => "> "))}
        </div>
      )}
      {chips}
      <div className="tc-ta">
        <textarea
          ref={ta}
          rows={compact ? 1 : 2}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          aria-label={placeholder}
          disabled={disabled}
          onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
          onKeyDown={keyDown}
          onPaste={(e) => {
            if (!longPaste) return;
            const t = e.clipboardData.getData("text/plain");
            if (t.length <= longPaste.over) return;
            e.preventDefault();
            longPaste.onPaste(t);
          }}
          onBlur={() => setTimeout(() => setMention(null), 150)}
        />
        {mention && options.length > 0 && (
          <div className="tc-ac" role="listbox">
            {options.map((o, i) => (
              <button key={o.key} type="button" role="option" aria-selected={i === pick} className={i === pick ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o.name)}>
                {o.node}
                <b>{o.name}</b>
                {o.sub && <span className="ld-small ld-muted">{o.sub}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tc-bar">
        <span className="tc-barl">
          {attach}
          <span style={{ position: "relative", display: "inline-flex" }}>
            <button type="button" className="tc-ib" aria-label="Add an emoji" onClick={() => setEmoji((v) => !v)}>😊</button>
            {emoji && (
              <EmojiPicker
                onPick={(e) => {
                  insert(e);
                  setEmoji(false);
                }}
                onClose={() => setEmoji(false)}
              />
            )}
          </span>
          <button type="button" className="tc-ib" aria-label="Mention someone" onClick={() => insert(value && !value.endsWith(" ") ? " @" : "@")}>@</button>
          {extra}
        </span>
        {!compact && <span className="ld-small ld-muted tc-hint">Enter sends · Shift+Enter for a new line</span>}
        <span className="ld-row">
          {onCancel && <button type="button" className="ld-btn sm" onClick={onCancel}>Cancel</button>}
          <button type="button" className="ld-btn p sm" disabled={disabled || busy} onClick={onSend}>{sendLabel}</button>
        </span>
      </div>
      {note && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)", padding: "0 10px 8px" }}>{note}</span>}
    </div>
  );
}
