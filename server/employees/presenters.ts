import fs from "node:fs";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import * as avatar from "./avatar";
import * as twin from "./twin";

/**
 * Who presents a demo or social video: the owner's twin (in a saved look), the owner's photo
 * avatar (Elena's Your avatar), or a made-up person from Elena's cast. Each one says an audio file
 * and comes back as a talking clip. Real clients are never presenters.
 */

export type Presenter = { type: "twin"; twinId: number; lookId?: number | null } | { type: "photo" } | { type: "cast"; castId: number };

export function parsePresenter(raw: string | null | undefined): Presenter | null {
  try {
    const p = JSON.parse(raw || "{}") as Presenter;
    if (p?.type === "twin" && Number.isInteger(p.twinId)) return { type: "twin", twinId: p.twinId, lookId: p.lookId ?? null };
    if (p?.type === "photo") return { type: "photo" };
    if (p?.type === "cast" && Number.isInteger(p.castId)) return { type: "cast", castId: p.castId };
  } catch {
    /* none */
  }
  return null;
}

const madeUp = (orgId: number) => db.listDramaCast(orgId).filter((c) => c.kind === "made_up");

/** Everyone who can present here, and the voices for screen-only videos. */
export async function options(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "video");
  const s = emp ? avatar.settingsOf(emp) : null;
  const pics = await avatar.photos(orgId);
  const photo = pics.find((p) => p.id === s?.imageId) ?? pics[0] ?? null;
  return {
    twins: twin.list(orgId).filter(twin.usable).map((t) => ({ id: t.id, name: t.name, thumbUrl: t.thumbUrl, looks: twin.looks(orgId, t.id).filter((l) => l.status === "saved").map((l) => ({ id: l.id, name: l.name, thumbUrl: l.thumbUrl })) })),
    photo: photo ? { url: photo.url, voiceName: s?.voiceName ?? null } : null,
    cast: madeUp(orgId).map((c) => ({ id: c.id, name: c.name, look: c.look, photoUrl: c.photoUrl })),
    voices: (await avatar.voices(orgId)).map((v) => ({ id: v.id, name: v.name, own: v.own })),
  };
}

export async function label(orgId: number, p: Presenter | null) {
  if (!p) return "Screen only";
  if (p.type === "twin") {
    const t = twin.get(orgId, p.twinId);
    const l = p.lookId ? twin.getLook(orgId, p.lookId) : null;
    return `${t?.name ?? "Twin"}'s twin${l ? `, ${l.name}` : ""}`;
  }
  if (p.type === "photo") return "My photo avatar";
  return db.getDramaCast(p.castId, orgId)?.name ?? "A made-up person";
}

/** The voice a presenter speaks in; for screen only, the one picked (or the workspace's own, or a standard voice). */
export async function voiceFor(orgId: number, p: Presenter | null, picked?: string | null) {
  const voices = await avatar.voices(orgId);
  const byId = (id?: string | null) => (id ? voices.find((v) => v.id === id) : undefined);
  if (p?.type === "twin") {
    const t = twin.get(orgId, p.twinId);
    if (t?.voiceId) return { id: t.voiceId, name: t.voiceName ?? `${t.name}'s voice` };
  }
  if (p?.type === "cast") {
    const c = db.getDramaCast(p.castId, orgId);
    if (c?.voiceId) return { id: c.voiceId, name: c.voiceName ?? c.name };
    const stock = voices.find((v) => !v.own);
    if (stock) return { id: stock.id, name: stock.name };
  }
  if (p?.type === "photo") {
    const emp = await db.getEmployeeByKind(orgId, "video");
    const s = emp ? avatar.settingsOf(emp) : null;
    if (s?.voiceId) return { id: s.voiceId, name: s.voiceName ?? "Your voice" };
  }
  const pick = byId(picked) ?? voices.find((v) => v.own) ?? voices.find((v) => v.id === `${avatar.STANDARD}coral`) ?? voices[0];
  if (!pick) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No voice is set up in this workspace yet." });
  return { id: pick.id, name: pick.name };
}

const PROMPT = "A natural talking-head video. The person speaks straight to the camera like they're showing a colleague how something works, with warm expressions, small natural head movements and the occasional hand gesture. Steady camera.";
const PROMPT_SOCIAL = "A natural talking-to-camera video, the kind a real person films on their phone. They speak straight to the camera like they're talking to a friend, with real expressions, small natural head movements and the occasional hand gesture. Steady handheld camera.";

/** The presenter saying the audio, as a local MP4 at outFile. */
export async function talkClip(orgId: number, p: Presenter, audioFile: string, outFile: string, social = false) {
  if (p.type === "twin") return twin.talk(orgId, p.twinId, p.lookId, audioFile, outFile);
  let image: string;
  if (p.type === "cast") {
    const c = db.getDramaCast(p.castId, orgId);
    if (!c) throw new Error("That person is no longer in Elena's cast.");
    image = await (await import("./drama")).portraitFor(orgId, c, "");
  } else {
    const o = await options(orgId);
    if (!o.photo) throw new Error("Add a photo of yourself under Your avatar on Elena's Videos tab first.");
    image = o.photo.url;
  }
  const drama = await import("./drama");
  const { falUpload } = await import("./editor");
  const broll = await import("./broll");
  const imageUrl = /^https?:/.test(image) ? image : await falUpload(broll.localFile(image), image.endsWith(".png") ? "image/png" : "image/jpeg");
  const r = await drama.falRun(avatar.MODEL.standard, { image_url: imageUrl, audio_url: await falUpload(audioFile, "audio/mpeg"), prompt: social ? PROMPT_SOCIAL : PROMPT }, 30);
  const url = r?.video?.url as string | undefined;
  if (!url) throw new Error("The avatar video didn't come back.");
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Couldn't download the avatar video (${res.status}).`);
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  return outFile;
}
