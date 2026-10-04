/**
 * Talking out loud with the employees (team huddles and one-on-ones in a chat).
 * The microphone streams to AssemblyAI for live transcription with a short-lived
 * token the server makes, so no key reaches the browser.
 */

/** A tiny silent sound. Playing it during the tap unlocks sound for the rest of the huddle (Safari and iPhone need this). */
export const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

const WORKLET = `
class Pcm extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(1600); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("pcm-16k", Pcm);
`;

export type Listener = { stop: () => void };

/** Streams the microphone at 16 kHz to AssemblyAI. While `muted()` is true it sends silence, so the session stays open. */
export async function listen(token: string, url: string, on: { partial: (t: string) => void; final: (t: string) => void; error: (m: string) => void }, muted: () => boolean): Promise<Listener> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const mod = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(mod);
  URL.revokeObjectURL(mod);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-16k");
  src.connect(node);
  const ws = new WebSocket(`${url}&token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  const silence = new Int16Array(1600).buffer;
  let lastTurn = -1;
  node.port.onmessage = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(muted() ? silence : (e.data as ArrayBuffer));
  };
  ws.onmessage = (e) => {
    let m: { type?: string; transcript?: string; end_of_turn?: boolean; turn_is_formatted?: boolean; turn_order?: number; error?: string };
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (m.error) on.error(m.error);
    if (m.type !== "Turn") return;
    const text = (m.transcript ?? "").trim();
    if (m.end_of_turn && m.turn_is_formatted) {
      if ((m.turn_order ?? 0) === lastTurn) return;
      lastTurn = m.turn_order ?? lastTurn + 1;
      on.partial("");
      if (text) on.final(text);
    } else on.partial(text);
  };
  ws.onclose = (e) => {
    if (e.code !== 1000 && e.code !== 1005) on.error(`Listening stopped (${e.reason || e.code}).`);
  };
  return {
    stop: () => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Terminate" }));
        ws.close();
      } catch {
        /* already closed */
      }
      node.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

/** Plain words for the errors people actually see when the microphone or the app can't be reached. */
export function micErrorText(err: unknown, again = "press Talk again") {
  if (!(err instanceof Error)) return "The microphone didn't start.";
  if (err.name === "NotAllowedError") return `Allow the microphone for this site, then ${again}.`;
  if (/failed to fetch|networkerror|load failed/i.test(err.message)) return `Your browser couldn't reach LeadDash Employees. Check your internet connection, then ${again}.`;
  return err.message;
}
