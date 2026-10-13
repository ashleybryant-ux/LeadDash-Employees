/**
 * The transitions Edit my video puts at every change between the person and b-roll, and how
 * ffmpeg makes each one. Simple ones are ffmpeg's own crossfades (xfade). The rest add a look to
 * the last moment of the outgoing shot and the first moment of the incoming one (blur, zoom,
 * shake, color), and the light effects lay a drawn overlay across the change (film burn, light
 * leak, light sweep, paper tear, fire wipe, comic dots). Overlays are drawn here, not licensed.
 */

export const TRANSITIONS = {
  none: { label: "None", group: "Simple" },
  fade: { label: "Fade", group: "Simple" },
  flash: { label: "Flash", group: "Simple" },
  black: { label: "Dip to black", group: "Simple" },
  slideup: { label: "Slide up", group: "Motion" },
  slidedown: { label: "Slide down", group: "Motion" },
  slideleft: { label: "Slide left", group: "Motion" },
  slideright: { label: "Slide right", group: "Motion" },
  zoomin: { label: "Zoom in", group: "Motion" },
  zoomout: { label: "Zoom out", group: "Motion" },
  zoomblur: { label: "Zoom blur", group: "Motion" },
  whip: { label: "Whip pan", group: "Motion" },
  shake: { label: "Shake", group: "Effects" },
  glitch: { label: "Glitch", group: "Effects" },
  vhs: { label: "VHS", group: "Effects" },
  retro: { label: "Retro film", group: "Effects" },
  filmburn: { label: "Film burn", group: "Effects" },
  lightleak: { label: "Light leak", group: "Effects" },
  sweep: { label: "Light sweep", group: "Effects" },
  papertear: { label: "Paper tear", group: "Effects" },
  firewipe: { label: "Fire wipe", group: "Effects" },
  pixel: { label: "Pixelate", group: "Effects" },
  circle: { label: "Circle", group: "Simple" },
  comic: { label: "Comic", group: "Effects" },
} as const;
export type TransKey = keyof typeof TRANSITIONS;
export const TRANS_KEYS = Object.keys(TRANSITIONS) as TransKey[];
export const isTrans = (k: unknown): k is TransKey => typeof k === "string" && k in TRANSITIONS;

export type Speed = "quick" | "normal" | "slow";
export const SPEED_SECONDS: Record<Speed, number> = { quick: 0.3, normal: 0.5, slow: 0.8 };
export const SPEED_LABEL: Record<Speed, string> = { quick: "Quick", normal: "Normal", slow: "Slow" };

/** What Elena reaches for when she picks: into b-roll, and back to the person. */
export const AUTO_INTO: TransKey[] = ["zoomblur", "whip", "slideleft", "lightleak", "sweep", "zoomin", "fade", "glitch"];
export const AUTO_BACK: TransKey[] = ["fade", "zoomout", "whip", "slideright", "flash", "lightleak"];

export type OverlayKind = "burn" | "leak" | "sweep" | "tear" | "fire" | "dots";

/** How ffmpeg makes it: the crossfade, looks on each side of the change, and an overlay. */
export type Recipe = {
  /** ffmpeg xfade transition; null is a straight cut. */
  xfade: string | null;
  /** Filters for the last `d` seconds of the outgoing shot, which is `L + d` long. */
  out?: (L: number, d: number, W: number, H: number) => string[];
  /** Filters for the first `d` seconds of the incoming shot. */
  in?: (d: number, W: number, H: number) => string[];
  overlay?: OverlayKind;
};

const zoom = (expr: string, W: number, H: number) => [`scale=w='trunc(iw*(${expr})/2)*2':h='trunc(ih*(${expr})/2)*2':eval=frame`, `crop=${W}:${H}`];
const after = (L: number) => `enable='gte(t,${L.toFixed(3)})'`;
const before = (d: number) => `enable='lt(t,${d.toFixed(3)})'`;
const SEPIA = "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131";

export const RECIPES: Record<TransKey, Recipe> = {
  none: { xfade: null },
  fade: { xfade: "fade" },
  flash: { xfade: "fadewhite" },
  black: { xfade: "fadeblack" },
  slideup: { xfade: "slideup" },
  slidedown: { xfade: "slidedown" },
  slideleft: { xfade: "slideleft" },
  slideright: { xfade: "slideright" },
  zoomin: { xfade: "zoomin" },
  pixel: { xfade: "pixelize" },
  circle: { xfade: "circleopen" },
  zoomout: { xfade: "fade", in: (d, W, H) => zoom(`if(lt(t,${d}),1.6-0.6*t/${d},1)`, W, H) },
  zoomblur: {
    xfade: "fade",
    out: (L, d, W, H) => [...zoom(`if(gte(t,${L}),1+0.6*(t-${L})/${d},1)`, W, H), `gblur=sigma=14:${after(L)}`],
    in: (d, W, H) => [...zoom(`if(lt(t,${d}),1.5-0.5*t/${d},1)`, W, H), `gblur=sigma=14:${before(d * 0.6)}`],
  },
  whip: {
    xfade: "slideleft",
    out: (L) => [`avgblur=sizeX=60:sizeY=1:${after(L)}`],
    in: (d) => [`avgblur=sizeX=60:sizeY=1:${before(d)}`],
  },
  shake: {
    xfade: "fade",
    in: (d, W, H) => [...zoom(`if(lt(t,${d}),1.12,1)`, W, H).slice(0, 1), `crop=${W}:${H}:x='(in_w-out_w)/2*(1+0.9*sin(t*90))':y='(in_h-out_h)/2*(1+0.9*cos(t*77))'`, `gblur=sigma=3:${before(d * 0.7)}`],
  },
  glitch: {
    xfade: "hrslice",
    out: (L) => [`rgbashift=rh=-24:bh=24:${after(L)}`, `noise=alls=40:allf=t:${after(L)}`],
    in: (d) => [`rgbashift=rh=24:bh=-24:${before(d)}`, `noise=alls=40:allf=t:${before(d)}`],
  },
  vhs: {
    xfade: "fade",
    out: (L) => [`rgbashift=rh=10:bh=-10:${after(L)}`, `eq=saturation=1.6:contrast=1.2:${after(L)}`, `noise=alls=35:allf=t:${after(L)}`, `drawgrid=w=iw:h=4:t=1:c=black@0.45:${after(L)}`],
    in: (d) => [`rgbashift=rh=10:bh=-10:${before(d)}`, `eq=saturation=1.6:contrast=1.2:${before(d)}`, `noise=alls=35:allf=t:${before(d)}`, `drawgrid=w=iw:h=4:t=1:c=black@0.45:${before(d)}`],
  },
  retro: {
    xfade: "fade",
    out: (L) => [`${SEPIA}:${after(L)}`, `vignette=PI/4:${after(L)}`, `noise=alls=20:allf=t:${after(L)}`],
    in: (d) => [`${SEPIA}:${before(d)}`, `vignette=PI/4:${before(d)}`, `noise=alls=20:allf=t:${before(d)}`],
  },
  filmburn: { xfade: "fadewhite", overlay: "burn" },
  lightleak: { xfade: "fade", overlay: "leak" },
  sweep: { xfade: "wiperight", overlay: "sweep" },
  papertear: { xfade: "wiperight", overlay: "tear" },
  firewipe: { xfade: "wiperight", overlay: "fire" },
  comic: { xfade: "diagbl", in: (d) => [`eq=contrast=1.35:saturation=1.7:${before(d * 1.5)}`], overlay: "dots" },
};

/** The overlay drawn as an SVG at the video's size (bands are a fraction of the width and move across). */
export function overlaySvg(kind: OverlayKind, W: number, H: number) {
  const band = Math.round(W * 0.42);
  const w = kind === "sweep" || kind === "tear" || kind === "fire" ? band : W;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">`;
  if (kind === "burn")
    return { w, svg: `${head}<defs><radialGradient id="g" cx="32%" cy="40%" r="75%"><stop offset="0" stop-color="#fff8d6"/><stop offset=".16" stop-color="#ffb238"/><stop offset=".38" stop-color="#e2420e" stop-opacity=".9"/><stop offset=".62" stop-color="#780a00" stop-opacity=".55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>` };
  if (kind === "leak")
    return { w, svg: `${head}<defs><radialGradient id="g" cx="30%" cy="50%" r="60%"><stop offset="0" stop-color="#ff7828" stop-opacity=".85"/><stop offset=".45" stop-color="#ff285a" stop-opacity=".5"/><stop offset="1" stop-color="#ff285a" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>` };
  if (kind === "sweep")
    return { w, svg: `${head}<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".42" stop-color="#fff" stop-opacity=".95"/><stop offset=".58" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>` };
  if (kind === "fire")
    return { w, svg: `${head}<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#ff6a00" stop-opacity="0"/><stop offset=".35" stop-color="#ff6a00" stop-opacity=".9"/><stop offset=".5" stop-color="#ffd23f"/><stop offset=".65" stop-color="#ff6a00" stop-opacity=".9"/><stop offset="1" stop-color="#ff6a00" stop-opacity="0"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="${Math.round(W / 120)}"/></filter></defs><rect width="100%" height="100%" fill="url(#g)" filter="url(#b)"/></svg>` };
  if (kind === "tear") {
    // A strip of torn paper: ragged on both edges, with a soft shadow.
    const pts = (x0: number, jit: number) => Array.from({ length: 25 }, (_, i) => `${(x0 + Math.sin(i * 2.7 + x0) * jit).toFixed(1)},${((i * H) / 24).toFixed(1)}`);
    const left = pts(w * 0.3, w * 0.07);
    const right = pts(w * 0.62, w * 0.06).reverse();
    return { w, svg: `${head}<polygon points="${[...left, ...right].join(" ")}" fill="#f4ead8" stroke="#d8c9ae" stroke-width="3"/></svg>` };
  }
  // Comic: halftone dots over the whole frame.
  const r = Math.max(2, Math.round(W / 300));
  const step = r * 5;
  return { w, svg: `${head}<defs><pattern id="p" width="${step}" height="${step}" patternUnits="userSpaceOnUse"><circle cx="${step / 2}" cy="${step / 2}" r="${r}" fill="#000" fill-opacity=".45"/></pattern></defs><rect width="100%" height="100%" fill="url(#p)"/></svg>` };
}

/** Bands follow the edge of the wipe; light washes fade in and out over the change. */
export const MOVES: Record<OverlayKind, "pulse" | "move" | "pulse-move"> = { burn: "pulse", leak: "pulse-move", dots: "pulse", sweep: "move", tear: "move", fire: "move" };
