/**
 * Public Projects pages, reached by a private link:
 * - /form/:token   a Projects form; each answer becomes a task
 * - /share/:token  a view-only page of one list, when its owner turned the link on
 * - /d/:token      a read-only copy of one doc, when its owner turned the public link on
 */
import type { Express, Request, Response } from "express";
import * as db from "./db";
import { parse, statusesOf, type Assignee } from "./work/projects";
import { publicForm, submit, type Question } from "./work/pjForms";
import type { Block } from "./work/pjDocs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// A few answers per visitor per hour keeps bots out.
const hits = new Map<string, number[]>();
function limited(req: Request, max = 20) {
  const key = `${req.ip}|${req.path}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

const CSS = `*{box-sizing:border-box}body{margin:0;background:#F8FAFB;font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;color:#14221c}
.wrap{max-width:620px;margin:0 auto;padding:40px 16px 56px}.card{background:#fff;border:1px solid #e3e9e6;border-radius:16px;padding:28px 30px;display:flex;flex-direction:column;gap:14px}
.logo{width:44px;height:44px;border-radius:12px;object-fit:cover;background:#1b6b4a}
h1{font-size:26px;margin:0;font-weight:800}p{font-size:15px;line-height:1.6;color:#3d4c45;margin:0}
.q{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:700}.q .req{color:#b42318}
input,textarea,select{width:100%;border:1px solid #cfd9d4;border-radius:9px;padding:10px 12px;font:inherit;font-size:16px;font-weight:400;background:#fff;color:#14221c}
textarea{min-height:96px;resize:vertical}.pills{display:flex;flex-wrap:wrap;gap:8px}
.pill{position:relative}.pill input{position:absolute;opacity:0;width:1px;height:1px}.pill span{display:inline-flex;height:36px;padding:0 14px;align-items:center;border:1px solid #cfd9d4;border-radius:9px;font-weight:700;font-size:14px;cursor:pointer;background:#fff}
.pill input:checked+span{background:#e6f2ec;border-color:#1b6b4a;color:#155c3e}.pill input:focus-visible+span{outline:2px solid #1b6b4a;outline-offset:2px}
.drop{border:1px dashed #9aa8a2;border-radius:10px;padding:16px;text-align:center;color:#5b6b64;font-weight:600;font-size:14px;cursor:pointer}
button{height:46px;border-radius:10px;border:0;background:#1b6b4a;color:#fff;font:inherit;font-weight:700;font-size:15px;cursor:pointer;width:100%}
button[disabled]{opacity:.6}.err{color:#b42318;font-weight:600;font-size:14px}.muted{color:#5b6b64;font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff;font-size:14px}th{font-size:11px;font-weight:800;color:#5b6b64;text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:10px 12px;border-bottom:1px solid #e3e9e6;background:#fafbfb}
td{padding:10px 12px;border-bottom:1px solid #eef2f0;vertical-align:top}.st{display:inline-block;color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
.wide{max-width:1000px}.tbl{border:1px solid #e3e9e6;border-radius:14px;overflow:auto}
.doc{max-width:760px}.doc h2{font-size:22px;margin:22px 0 6px}.doc h3{font-size:17px;margin:18px 0 4px}.doc p{margin:0 0 10px;font-size:16px;line-height:1.65;color:#14221c}.doc .li{margin:0 0 4px 8px}.doc blockquote{margin:10px 0;padding:6px 14px;border-left:3px solid #1b6b4a;color:#3d4c45}.doc hr{border:0;border-top:1px solid #e3e9e6;margin:18px 0}.doc img{max-width:100%;border-radius:10px;margin:8px 0}.doc .ck{display:flex;gap:8px;align-items:flex-start;margin:0 0 4px}.doc table{margin:10px 0;border:1px solid #e3e9e6}`;

function shell(title: string, body: string, wide = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap"><style>${CSS}</style></head><body><div class="wrap${wide ? " wide" : ""}">${body}</div></body></html>`;
}
const notFound = () => shell("Not found", `<div class="card"><h1>Not found</h1><p>This link isn't active.</p></div>`);

function field(q: Question) {
  const id = `q_${esc(q.id)}`;
  const req = q.required ? " required" : "";
  const star = q.required ? ' <span class="req" aria-hidden="true">*</span>' : "";
  if (q.type === "longtext") return `<label class="q" for="${id}"><span>${esc(q.label)}${star}</span><textarea id="${id}" name="${esc(q.id)}"${req}></textarea></label>`;
  if (q.type === "dropdown") return `<label class="q" for="${id}"><span>${esc(q.label)}${star}</span><select id="${id}" name="${esc(q.id)}"${req}><option value="">Pick one</option>${(q.options ?? []).map((o) => `<option>${esc(o)}</option>`).join("")}</select></label>`;
  if (q.type === "labels") return `<fieldset class="q" style="border:0;padding:0;margin:0"><legend style="padding:0;margin-bottom:6px">${esc(q.label)}${star}</legend><div class="pills">${(q.options ?? []).map((o) => `<label class="pill"><input type="checkbox" name="${esc(q.id)}" value="${esc(o)}"><span>${esc(o)}</span></label>`).join("")}</div></fieldset>`;
  if (q.type === "files") return `<div class="q"><span>${esc(q.label)}${star}</span><label class="drop" for="${id}">Drop files or browse<input id="${id}" type="file" multiple data-files="${esc(q.id)}" style="display:none"></label><span class="muted" id="${id}_names"></span></div>`;
  const type = q.type === "email" ? "email" : q.type === "phone" ? "tel" : q.type === "number" ? "number" : q.type === "date" ? "text" : "text";
  const ph = q.type === "date" ? ' placeholder="MM/DD/YYYY" inputmode="numeric"' : "";
  return `<label class="q" for="${id}"><span>${esc(q.label)}${star}</span><input id="${id}" name="${esc(q.id)}" type="${type}"${ph}${req}${q.type === "date" ? ' data-date="1"' : ""}></label>`;
}

// Sends the answers as JSON (files as base64) and shows the thank-you in place.
const SCRIPT = `<script>
(function(){var f=document.getElementById('pf');if(!f)return;var msg=document.getElementById('msg');
document.querySelectorAll('input[data-files]').forEach(function(i){i.addEventListener('change',function(){document.getElementById(i.id+'_names').textContent=Array.from(i.files).map(function(x){return x.name}).join(', ')})});
function b64(file){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(String(r.result).split(',')[1]||'')};r.onerror=rej;r.readAsDataURL(file)})}
f.addEventListener('submit',async function(e){e.preventDefault();var btn=f.querySelector('button');btn.disabled=true;msg.textContent='';
var vals={};var fd=new FormData(f);fd.forEach(function(v,k){if(k==='website')return;if(vals[k]!==undefined){vals[k]=[].concat(vals[k],v)}else{vals[k]=v}});
f.querySelectorAll('input[type=checkbox]').forEach(function(c){if(!(c.name in vals))vals[c.name]=[];else if(!Array.isArray(vals[c.name]))vals[c.name]=[vals[c.name]]});
f.querySelectorAll('input[data-date]').forEach(function(i){var m=/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec(i.value.trim());vals[i.name]=m?m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0'):(i.value.trim()?'bad':'')});
var files={};for(var i of Array.from(f.querySelectorAll('input[data-files]'))){files[i.dataset.files]=[];for(var x of Array.from(i.files)){files[i.dataset.files].push({name:x.name,mime:x.type,data:await b64(x)})}}
try{var r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({values:vals,files:files,website:fd.get('website')||''})});var j=await r.json();
if(!r.ok){msg.textContent=j.error||'That didn\\'t go through.';btn.disabled=false;return}
f.parentNode.innerHTML='<h1>Thank you</h1><p>'+j.thanks.replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})+'</p>'}catch(err){msg.textContent='That didn\\'t go through. Try again.';btn.disabled=false}})})();
</script>`;

export function registerProjectPages(app: Express) {
  app.get("/form/:token", async (req, res) => {
    const f = await publicForm(String(req.params.token));
    if (!f) return res.status(404).send(notFound());
    const logo = f.logoUrl && /^https:\/\//.test(f.logoUrl) ? `<img class="logo" src="${esc(f.logoUrl)}" alt="">` : `<span class="logo" aria-hidden="true"></span>`;
    res.send(
      shell(
        f.title,
        `<div class="card">${logo}<h1>${esc(f.title)}</h1>${f.intro ? `<p>${esc(f.intro)}</p>` : ""}
<form id="pf" novalidate style="display:flex;flex-direction:column;gap:14px"><input name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
${f.questions.map(field).join("\n")}
<p class="err" id="msg" role="alert"></p><button type="submit">Send</button></form>
<p class="muted">${esc(f.orgName)} · Sent with LeadDash Employees</p></div>${SCRIPT}`
      )
    );
  });

  app.post("/form/:token", async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { values?: Record<string, unknown>; files?: Record<string, { name: string; mime: string; data: string }[]>; website?: string };
    if (b.website) return res.json({ thanks: "Thanks. We got it." });
    if (limited(req)) return res.status(429).json({ error: "Too many answers from this connection. Try again in an hour." });
    try {
      const r = await submit(String(req.params.token), b.values ?? {}, b.files ?? {});
      res.json(r);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "That didn't go through." });
    }
  });

  app.get("/d/:token", async (req, res) => {
    const d = db.docByShareToken(String(req.params.token));
    if (!d || d.archivedAt) return res.status(404).send(notFound());
    const org = await db.getOrganizationById(d.organizationId);
    const mark = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*(?!\*)(.+?)\*/g, "$1<i>$2</i>");
    let n = 0;
    const body = parse<Block[]>(d.blocks, [])
      .map((b) => {
        n = b.type === "number" ? n + 1 : 0;
        if (b.type === "h1") return `<h2>${mark(b.text)}</h2>`;
        if (b.type === "h2") return `<h3>${mark(b.text)}</h3>`;
        if (b.type === "bullet") return `<p class="li">• ${mark(b.text)}</p>`;
        if (b.type === "number") return `<p class="li">${n}. ${mark(b.text)}</p>`;
        if (b.type === "check") return `<p class="ck"><span>${b.done ? "☑" : "☐"}</span><span${b.done ? ' style="text-decoration:line-through;color:#5b6b64"' : ""}>${mark(b.text)}</span></p>`;
        if (b.type === "quote") return `<blockquote>${mark(b.text)}</blockquote>`;
        if (b.type === "divider") return "<hr>";
        if (b.type === "image") return b.url ? `<img src="${esc(b.url)}" alt="${esc(b.text || "")}">` : "";
        if (b.type === "table") return `<table>${(b.rows ?? []).map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`).join("")}</table>`;
        if (b.type === "task") return "";
        return `<p>${mark(b.text) || "&nbsp;"}</p>`;
      })
      .join("");
    const pages = db.work.docs.where(d.organizationId, "parentId", d.id).sort((a, b) => a.sort - b.sort || a.id - b.id);
    res.send(shell(d.title, `<div class="card doc"><div><h1>${esc(d.title)}</h1><p class="muted">${esc(org?.name ?? "")} · View only</p></div><div>${body}</div>${pages.length ? `<p class="muted">Pages in this doc: ${pages.map((p) => esc(p.title)).join(", ")}</p>` : ""}</div>`, true));
  });

  app.get("/share/:token", async (req, res) => {
    const l = db.listByShareToken(String(req.params.token));
    if (!l) return res.status(404).send(notFound());
    const org = await db.getOrganizationById(l.organizationId);
    const sts = statusesOf(l);
    const tasks = db.work.tasks.where(l.organizationId, "listId", l.id).filter((t) => !t.parentId).sort((a, b) => a.sort - b.sort || a.id - b.id);
    const fmt = (s: string | null) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
    const rows = tasks
      .map((t) => {
        const s = sts.find((x) => x.name === t.status);
        return `<tr><td>${esc(t.name)}</td><td><span class="st" style="background:${s?.color ?? "#87909e"}">${esc(t.status)}</span></td><td>${esc(parse<Assignee[]>(t.assignees, []).map((a) => a.name).join(", "))}</td><td>${fmt(t.dueDate)}</td></tr>`;
      })
      .join("");
    res.send(shell(l.name, `<div style="display:flex;flex-direction:column;gap:14px"><div><h1>${esc(l.name)}</h1><p class="muted">${esc(org?.name ?? "")} · View only</p></div><div class="tbl"><table><thead><tr><th>Task</th><th>Status</th><th>Assignees</th><th>Due</th></tr></thead><tbody>${rows || `<tr><td colspan="4">No tasks yet.</td></tr>`}</tbody></table></div></div>`, true));
  });
}
