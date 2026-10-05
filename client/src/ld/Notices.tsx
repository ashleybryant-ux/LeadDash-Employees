import React from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { playSound, unlockSoundOnFirstTap, type SoundKind } from "./sounds";

/**
 * While the app is open: a pop-up in the corner for each new notice (a
 * teammate's message, something waiting in Approvals...), and a sound when the
 * person turned Sound on for that kind of notice in My account.
 */

type Toast = { id: number; title: string; body: string; url: string; sounded: boolean };

export default function Notices() {
  const { currentOrgId } = useTenant();
  const [location, go] = useLocation();
  const account = trpc.account.get.useQuery(undefined, { staleTime: 60_000 });
  const after = React.useRef<number | null>(null);
  const q = trpc.account.pings.useQuery({ after: 0 }, { refetchInterval: 6_000, refetchIntervalInBackground: true });
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  React.useEffect(() => unlockSoundOnFirstTap(), []);

  React.useEffect(() => {
    const d = q.data;
    if (!d) return;
    // The first answer only says where we are: older notices don't pop up when the app opens.
    if (after.current === null) {
      after.current = d.latest;
      return;
    }
    const fresh = d.pings.filter((p) => p.id > (after.current ?? 0));
    after.current = Math.max(after.current, d.latest);
    if (!fresh.length) return;
    const prefs = account.data?.prefs as Record<string, { sound: boolean }> | undefined;
    const sound = account.data?.sound as { kind: SoundKind; volume: number } | undefined;
    // Already looking at it: no pop-up and no sound.
    const shown = fresh.filter((p) => p.orgId === currentOrgId && p.url !== location);
    if (!shown.length) return;
    const wantsSound = shown.some((p) => prefs?.[p.event]?.sound);
    if (wantsSound && sound) playSound(sound.kind, sound.volume);
    setToasts((t) => [...t, ...shown.map((p) => ({ id: p.id, title: p.title, body: p.body, url: p.url, sounded: !!prefs?.[p.event]?.sound }))].slice(-3));
    for (const p of shown) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== p.id)), 7_000);
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!toasts.length) return null;
  return (
    <div className="ld-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className="ld-toast"
          onClick={() => {
            setToasts((x) => x.filter((y) => y.id !== t.id));
            go(t.url);
          }}
        >
          <b>{t.title}</b>
          <span>{t.body}</span>
          {t.sounded && <span className="ld-toast-note">Played a sound · turn sounds off in My account</span>}
        </button>
      ))}
    </div>
  );
}
