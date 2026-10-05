/**
 * The notice sounds, made in the browser (no sound files): a chime, a soft
 * knock and a bell. Browsers only allow sound after the person has clicked or
 * tapped on the page once, so the audio is unlocked on the first tap.
 */

export type SoundKind = "chime" | "knock" | "bell";

let ctx: AudioContext | null = null;

function audio() {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

/** Call once at startup: the first tap anywhere lets sounds play later. */
export function unlockSoundOnFirstTap() {
  const go = () => {
    const a = audio();
    if (a && a.state === "suspended") void a.resume();
    window.removeEventListener("pointerdown", go);
    window.removeEventListener("keydown", go);
  };
  window.addEventListener("pointerdown", go);
  window.addEventListener("keydown", go);
}

function tone(a: AudioContext, out: GainNode, freq: number, start: number, length: number, type: OscillatorType, peak: number) {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + length);
  o.connect(g).connect(out);
  o.start(start);
  o.stop(start + length + 0.05);
}

export function playSound(kind: SoundKind, volume: number) {
  const a = audio();
  if (!a || volume <= 0) return;
  if (a.state === "suspended") void a.resume();
  const out = a.createGain();
  out.gain.value = Math.min(1, volume / 100);
  out.connect(a.destination);
  const t = a.currentTime + 0.02;
  if (kind === "chime") {
    tone(a, out, 880, t, 0.45, "sine", 0.5);
    tone(a, out, 1318.5, t + 0.13, 0.6, "sine", 0.4);
  } else if (kind === "knock") {
    tone(a, out, 180, t, 0.12, "triangle", 0.9);
    tone(a, out, 180, t + 0.16, 0.12, "triangle", 0.9);
  } else {
    tone(a, out, 1046.5, t, 1.2, "sine", 0.5);
    tone(a, out, 2093, t, 0.6, "sine", 0.15);
    tone(a, out, 1568, t, 0.9, "sine", 0.12);
  }
}
