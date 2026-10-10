import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { listen, micErrorText, type Listener } from "./voice";

/**
 * Dictate instead of typing: press the microphone, talk, and each finished
 * sentence lands in the box. The same live transcription the huddles use.
 */
export function useDictation(onText: (text: string) => void) {
  const { currentOrgId } = useTenant();
  const token = trpc.huddle.listenToken.useMutation();
  const [on, setOn] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [partial, setPartial] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const ref = React.useRef<Listener | null>(null);
  const cb = React.useRef(onText);
  cb.current = onText;
  const stop = React.useCallback(() => {
    ref.current?.stop();
    ref.current = null;
    setOn(false);
    setPartial("");
  }, []);
  React.useEffect(() => stop, [stop]);
  const start = async () => {
    if (ref.current) return;
    setError(null);
    setStarting(true);
    try {
      const t = await token.mutateAsync({ organizationId: currentOrgId });
      ref.current = await listen(t.token, t.url, { partial: setPartial, final: (text) => cb.current(text), error: (m) => setError(m) }, () => false);
      setOn(true);
    } catch (err) {
      setError(micErrorText(err, "press Dictate again"));
    }
    setStarting(false);
  };
  return { on, starting, partial, error, start, stop, toggle: () => (on ? stop() : start()) };
}

/** The Dictate button for a text box. `onText` gets each finished sentence; append it to the box's value. */
export function DictateButton({ onText, small, label = "Dictate" }: { onText: (text: string) => void; small?: boolean; label?: string }) {
  const d = useDictation(onText);
  return (
    <span className="ld-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <button type="button" className={`ld-btn ${small ? "sm" : ""} ${d.on ? "p" : ""}`} style={{ width: small ? 110 : 128 }} aria-pressed={d.on} disabled={d.starting} onClick={d.toggle}>
        {d.starting ? "Starting" : d.on ? "Stop" : `🎙 ${label}`}
      </button>
      {d.on && <span className="ld-small ld-muted">{d.partial ? d.partial : "Listening. Talk, then press Stop."}</span>}
      {d.error && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>{d.error}</span>}
    </span>
  );
}

/** Adds dictated words to a box's value, with a space between sentences. */
export const appendText = (prev: string, text: string) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${text}` : text);
