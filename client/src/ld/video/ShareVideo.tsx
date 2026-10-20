import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";

/**
 * Share on a finished video (Elena's Videos tab and her chat cards). Share makes a watch link anyone
 * can open without signing in; the panel copies it, hands it (or the video file itself, where the
 * phone allows files) to the share sheet, and Stop sharing turns the link off for good.
 * Returns the button (for the view's button column) and the panel (shown below the column).
 */
export type ShareSource = "video" | "edit" | "scene";

const fileShareWorks = () => {
  try {
    return typeof navigator !== "undefined" && typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([""], "video.mp4", { type: "video/mp4" })] });
  } catch {
    return false;
  }
};

export function useVideoShare({ source, id, title, fileUrl, small }: { source: ShareSource; id: number; title: string; fileUrl: string | null; small?: boolean }) {
  const { currentOrgId: orgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.videoShares.get.useQuery({ organizationId: orgId, source, id }, { enabled: orgId > 0 && !!fileUrl });
  const set = trpc.videoShares.set.useMutation({ onSuccess: () => utils.videoShares.get.invalidate({ organizationId: orgId, source, id }) });
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [fetching, setFetching] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const link = q.data?.link ? new URL(q.data.link, window.location.origin).toString() : null;
  const canSend = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const canSendFile = React.useMemo(fileShareWorks, []);
  const name = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "video"}.mp4`;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* Copy link stays there to press. */
    }
  };

  // Share: make the link (or reuse it), open the panel and copy the link.
  const press = async () => {
    setNote(null);
    if (open) return setOpen(false);
    setOpen(true);
    const r = q.data?.link ? q.data : await set.mutateAsync({ organizationId: orgId, source, id, on: true }).catch(() => null);
    if (r?.link) void copy(new URL(r.link, window.location.origin).toString());
  };

  const sendLink = async () => {
    if (!link) return;
    try {
      await navigator.share({ title, url: link });
    } catch {
      /* Closed the share sheet. */
    }
  };

  // The video file itself: fetched once, then handed to the share sheet. A phone that needs a fresh tap after the download gets "Send now".
  const sendFile = async () => {
    setNote(null);
    let f = file;
    if (!f && fileUrl) {
      setFetching(true);
      try {
        const res = await fetch(fileUrl, { credentials: "include" });
        if (!res.ok) throw new Error();
        f = new File([await res.blob()], name, { type: "video/mp4" });
        setFile(f);
      } catch {
        setNote("The video couldn't be loaded. Send the link instead.");
      }
      setFetching(false);
    }
    if (!f) return;
    try {
      await navigator.share({ files: [f], title });
    } catch (err) {
      if ((err as Error)?.name === "NotAllowedError") setNote("The video is ready. Press Send now.");
    }
  };

  const button = (
    <button type="button" className={`ld-btn${small ? " sm" : ""}`} aria-expanded={open} disabled={!fileUrl || set.isPending} onClick={press}>
      {set.isPending && !link ? "Sharing..." : "Share"}
    </button>
  );

  const panel = open ? (
    <div className="ld-vshare" role="region" aria-label="Share this video">
      {link ? (
        <>
          <div className="ld-vshare-link">
            <input className="ld-in" readOnly value={link} aria-label="Watch link" onFocus={(e) => e.currentTarget.select()} />
          </div>
          <div className="ld-vshare-btns">
            <button type="button" className="ld-btn p" onClick={() => copy(link)}>{copied ? "Link copied" : "Copy link"}</button>
            {canSend && <button type="button" className="ld-btn" onClick={sendLink}>Send link</button>}
            {canSend && canSendFile && fileUrl && (
              <button type="button" className="ld-btn" disabled={fetching} onClick={sendFile}>{fetching ? "Getting video..." : file ? "Send now" : "Send video"}</button>
            )}
            <button type="button" className="ld-btn" disabled={set.isPending} onClick={() => set.mutate({ organizationId: orgId, source, id, on: false }, { onSuccess: () => setOpen(false) })}>Stop sharing</button>
          </div>
          <span className="ld-small" style={{ color: "var(--ld-text2)" }}>Anyone with the link can watch it without signing in. They see your workspace name and the video, nothing else.</span>
        </>
      ) : (
        <span className="ld-small">{set.isPending || q.isLoading ? "Making the link..." : ""}</span>
      )}
      {note && <span className="ld-small">{note}</span>}
      <ErrorLine error={set.error ?? q.error} />
    </div>
  ) : null;

  return { button, panel, shared: !!link };
}
