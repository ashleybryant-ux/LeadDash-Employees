import express, { type Express, type Request, type Response } from "express";
import { audioClip, botHeard, botNext, botPageData } from "./employees/huddle";

/**
 * Huddle routes outside tRPC:
 * - /api/voice/audio/:id: an employee's spoken answer (unguessable id, kept 15 minutes).
 * - /voice/bot/:token: the page the meeting bot shows as its camera; it plays each answer into the meeting.
 * - /api/voice/bot/:token/next and /transcript: what that page plays next, and Recall's live transcript webhook.
 * The token is a 48-character secret made for each huddle.
 */

const TOKEN = /^[a-f0-9]{48}$/;

export function registerVoice(app: Express) {
  app.get("/api/voice/audio/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const buf = /^[a-f0-9]{32}$/.test(id) ? audioClip(id) : null;
    if (!buf) return res.status(404).send("Not found");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=900");
    res.send(buf);
  });

  app.post("/api/voice/bot/:token/transcript", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    const token = String(req.params.token);
    if (!TOKEN.test(token)) return res.status(404).json({ error: "Not found" });
    // Answer Recall right away; the turn runs after.
    res.json({ ok: true });
    void botHeard(token, req.body).catch((err) => console.warn("[voice] webhook failed:", err instanceof Error ? err.message : err));
  });

  app.get("/api/voice/bot/:token/next", (req: Request, res: Response) => {
    const token = String(req.params.token);
    if (!TOKEN.test(token)) return res.status(404).json({ error: "Not found" });
    res.setHeader("Cache-Control", "no-store");
    res.json(botNext(token, Number(req.query.after ?? -1)));
  });

  app.get("/voice/bot/:token", async (req: Request, res: Response) => {
    const token = String(req.params.token);
    const data = TOKEN.test(token) ? await botPageData(token) : null;
    if (!data) return res.status(404).send("Not found");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(botPage(token, data));
  });
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function botPage(token: string, data: { emps: { kind: string; name: string; role: string }[]; lastIndex: number }) {
  const tiles = data.emps
    .map((e) => `<div class="t" data-kind="${esc(e.kind)}"><img src="/avatars/${esc(e.kind)}.webp" alt=""><b>${esc(e.name)}</b><span>${esc(e.role)}</span></div>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>LeadDash Team</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:#0f2a20;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;padding:40px}
.grid{display:flex;flex-wrap:wrap;gap:22px;justify-content:center;max-width:1180px}
.t{width:150px;display:flex;flex-direction:column;align-items:center;gap:6px;opacity:.82;transition:opacity .2s}
.t img{width:104px;height:104px;border-radius:999px;object-fit:cover;box-shadow:0 0 0 3px #0f2a20}
.t b{font-size:18px}
.t span{font-size:12px;color:#b9d3c6;text-align:center}
.t.on{opacity:1}
.t.on img{box-shadow:0 0 0 4px #0f2a20,0 0 0 9px #6fd39b}
.cap{min-height:64px;max-width:1000px;text-align:center;font-size:22px;line-height:1.4;color:#e8f3ed}
.brand{position:absolute;left:24px;bottom:18px;font-size:14px;color:#9cc0ae}
</style>
</head>
<body>
<div class="wrap"><div class="grid">${tiles}</div><div class="cap" id="cap"></div></div>
<div class="brand">LeadDash Team (AI)</div>
<audio id="a" autoplay></audio>
<script>
(function(){
  var token=${JSON.stringify(token)};
  var after=${data.lastIndex};
  var queue=[];var playing=false;
  var a=document.getElementById("a");var cap=document.getElementById("cap");
  function light(kind){document.querySelectorAll(".t").forEach(function(t){t.classList.toggle("on",t.getAttribute("data-kind")===kind)});}
  function next(){
    if(playing||!queue.length)return;
    var l=queue.shift();playing=true;light(l.kind);cap.textContent=l.name+": "+l.text;
    var done=function(){playing=false;light(null);setTimeout(function(){if(!playing)cap.textContent="";},2500);next();};
    if(!l.audioId){setTimeout(done,Math.min(9000,1500+l.text.length*55));return;}
    a.src="/api/voice/audio/"+l.audioId;a.onended=done;a.onerror=done;
    var p=a.play();if(p&&p.catch)p.catch(done);
  }
  function hush(){
    // A person is talking: whatever was playing stops, and what was lined up is dropped.
    queue=[];
    if(playing){try{a.pause();a.currentTime=0;}catch(e){}playing=false;light(null);cap.textContent="";}
  }
  function poll(){
    fetch("/api/voice/bot/"+token+"/next?after="+after,{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){
      (d.lines||[]).forEach(function(l){after=Math.max(after,l.index);queue.push(l);});
      if(d.hush)hush();else next();
      setTimeout(poll,d.live===false?5000:d.hush?300:700);
    }).catch(function(){setTimeout(poll,2000);});
  }
  poll();
})();
</script>
</body>
</html>`;
}
