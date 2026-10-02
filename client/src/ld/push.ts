/**
 * Push notifications in the browser: the service worker, permission and the
 * subscription the server sends notices to.
 */

export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** iPhone and iPad only allow push from the app added to the Home Screen. */
export function needsHomeScreen() {
  return isIos() && !isStandalone();
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad" : /Android/.test(ua) ? "Android phone" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Computer";
  if (device === "iPhone" || device === "iPad") return isStandalone() ? device : `Safari on ${device}`;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return device === "Android phone" ? device : `${browser} on ${device}`;
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

function keyBytes(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await registerServiceWorker());
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Asks permission and subscribes this browser. Returns what the server needs. */
export async function subscribe(vapidPublicKey: string) {
  if (!pushSupported()) throw new Error("This browser cannot get push notifications.");
  if (needsHomeScreen()) throw new Error("On iPhone, add this app to your Home Screen first, then open it from there.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in your browser settings, then try again.");
  const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await registerServiceWorker());
  if (!reg) throw new Error("The app could not start its notification helper. Reload and try again.");
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  return { endpoint: json.endpoint, keys: json.keys, device: deviceLabel() };
}

export async function unsubscribeHere() {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe();
  return sub?.endpoint ?? null;
}
