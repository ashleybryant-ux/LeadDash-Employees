/**
 * Public pages anyone can open without signing in: /about (the App home page
 * Google and Meta check), /privacy and /terms. Served as plain HTML from the
 * server so reviewers and crawlers see the full text without running the app.
 */
import type { Express } from "express";
import { parse as parseCookies } from "cookie";
import { SESSION_COOKIE } from "@shared/const";

const COMPANY = "LeadDash Marketing LLC";
const ADDRESS = "11901 N. MacArthur Blvd, Suite C6, Oklahoma City, OK 73162";
const SUPPORT = "ashleyb@leaddash.io";
const EFFECTIVE = "October 2, 2026";

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#F8FAFB;font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;color:#14221c}
a{color:#1b6b4a}
.top{min-height:68px;background:#fff;border-bottom:1px solid #e3e9e6;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 48px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:17px;color:#14221c;text-decoration:none}
.lg{width:34px;height:34px;border-radius:9px;background:#12211d;color:#fff;font-weight:800;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.nav{display:flex;align-items:center;gap:24px;font-size:14px;font-weight:700}
.nav a{color:#3d4c45;text-decoration:none}
.nav a[aria-current=page]{color:#14221c;text-decoration:underline;text-underline-offset:4px}
.nav a.btn,.btn{height:40px;padding:0 20px;border-radius:10px;border:1px solid #1b6b4a;background:#1b6b4a;color:#fff;font-size:14px;font-weight:700;display:inline-flex;align-items:center;text-decoration:none;white-space:nowrap}
.wrap{max-width:1040px;margin:0 auto;padding:56px 48px}
.doc{max-width:760px;margin:0 auto;padding:48px 48px 64px}
h1{font-size:40px;line-height:1.15;margin:0 0 16px;font-weight:800;letter-spacing:-.01em}
.doc h1{font-size:32px;margin-bottom:6px}
h2{font-size:22px;margin:40px 0 14px;font-weight:800}
.doc h2{font-size:18px;margin:32px 0 10px}
p,li{font-size:15px;line-height:1.65;color:#2a3a33}
ul{padding-left:22px}
.tag{font-size:24px;line-height:1.35;font-weight:700;color:#14221c;margin:0 0 14px;max-width:760px}
.lead{font-size:18px;line-height:1.6;color:#3d4c45;max-width:720px}
.muted{color:#5b6b64;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.emp{background:#fff;border:1px solid #e3e9e6;border-radius:12px;padding:16px}
.av{width:40px;height:40px;border-radius:999px;display:block;margin-bottom:10px;object-fit:cover}
.en{font-weight:800;font-size:15px}
.ej{font-size:12px;font-weight:700;color:#5b6b64;text-transform:uppercase;letter-spacing:.06em;margin:2px 0 6px}
.ed{font-size:13px;line-height:1.5;color:#3d4c45}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.st{background:#fff;border:1px solid #e3e9e6;border-radius:12px;padding:18px}
.st p{margin:6px 0 0}
.num{width:28px;height:28px;border-radius:999px;background:#e6f2ec;color:#155c3e;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center;margin-bottom:10px}
.tbl{background:#fff;border:1px solid #e3e9e6;border-radius:12px;overflow:hidden}
.tr{display:grid;grid-template-columns:200px minmax(0,1.1fr) minmax(0,1.4fr);gap:16px;padding:14px 18px;border-bottom:1px solid #eef2f0;font-size:14px;line-height:1.55}
.doc .tr{grid-template-columns:150px minmax(0,1fr) minmax(0,1fr)}
.tr.h{font-size:12px;font-weight:700;color:#5b6b64;text-transform:uppercase;letter-spacing:.06em;padding:10px 18px}
.tr:last-child{border-bottom:0}
.foot{border-top:1px solid #e3e9e6;background:#fff;padding:24px 48px;display:flex;justify-content:space-between;gap:16px;font-size:13px;color:#5b6b64}
.foot a{color:#3d4c45;margin-left:18px}
@media (max-width:760px){
  .top{padding:12px 16px;flex-wrap:wrap}
  .nav{gap:16px}
  .wrap,.doc{padding:32px 16px 48px}
  h1{font-size:30px}
  .doc h1{font-size:26px}
  .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .steps{grid-template-columns:1fr}
  .tr,.doc .tr{grid-template-columns:1fr;gap:4px}
  .tr.h{display:none}
  .foot{flex-direction:column;padding:20px 16px}
  .foot a{margin:0 18px 0 0}
}
@media (max-width:420px){.grid{grid-template-columns:1fr}}
`;

type Key = "about" | "privacy" | "terms";

function shell(key: Key, title: string, description: string, body: string) {
  const cur = (k: Key) => (k === key ? ' aria-current="page"' : "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/"><span class="lg">LD</span>LeadDash Employees</a>
  <nav class="nav" aria-label="Site"><a href="/privacy"${cur("privacy")}>Privacy</a><a href="/terms"${cur("terms")}>Terms</a><a class="btn" href="/signin">Sign in</a></nav>
</header>
${body}
<footer class="foot">
  <span>© 2026 ${COMPANY} · ${ADDRESS}</span>
  <span><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="mailto:${SUPPORT}">${SUPPORT}</a></span>
</footer>
</body>
</html>`;
}

const EMPLOYEES = [
  ["grants", "Morgan", "Grants", "Finds grants, pitch competitions and accelerators, and writes the applications."],
  ["speaking", "Taylor", "Speaking", "Finds conferences and events and writes the speaking pitches."],
  ["social", "Sienna", "Social media", "Writes posts for LinkedIn, Facebook, Instagram and X, with images."],
  ["blog", "Theo", "Blog", "Writes articles and saves them as drafts on your website."],
  ["website", "Jordan", "Website", "Plans website pages, sections and copy."],
  ["video", "Elena", "Video", "Finds video ideas and trends and plans short videos."],
  ["inbox", "Avery", "Inbox and calendar", "Drafts emails and meeting invites for you to approve."],
  ["custom", "Quinn", "Hiring", "Writes job posts, screens applicants and drafts outreach."],
] as const;

const CONNECT = [
  ["Google", "Send email (gmail.send) and create calendar events (calendar.events)", "Avery sends the emails you approve from your address and adds the meetings you approve to your calendar. We never read your inbox or your calendar."],
  ["LinkedIn", "Your name, email and permission to post", "Sienna publishes the posts you approve to your profile."],
  ["Facebook and Instagram", "The Pages you manage and their linked Instagram accounts", "Sienna publishes the posts you approve to the Page and Instagram account you pick."],
  ["X", "Your username and permission to post", "Sienna publishes the posts you approve."],
  ["Google Business Profile", "Your business listing", "Sienna publishes the updates you approve to your listing."],
] as const;

function table(head: [string, string, string], rows: readonly (readonly [string, string, string])[]) {
  return `<div class="tbl" role="table"><div class="tr h" role="row"><span>${head[0]}</span><span>${head[1]}</span><span>${head[2]}</span></div>${rows
    .map(([a, b, c]) => `<div class="tr" role="row"><b>${a}</b><span>${b}</span><span>${c}</span></div>`)
    .join("")}</div>`;
}

export function aboutPage() {
  const grid = EMPLOYEES.map(
    ([file, name, job, does]) =>
      `<div class="emp"><img class="av" src="/avatars/${file}.webp" alt="" width="40" height="40"><div class="en">${name}</div><div class="ej">${job}</div><div class="ed">${does}</div></div>`
  ).join("");
  const body = `<main class="wrap">
<h1>LeadDash Employees</h1>
<p class="tag">AI employees for your business. You approve everything they send.</p>
<p class="lead">LeadDash Employees is a web app that gives a small business a team of AI employees. It finds grants, writes posts and articles, drafts emails and meeting invites, plans pages and videos, and helps you hire. Each employee works from what you tell it about your business, and nothing is sent, posted or submitted until you approve it.</p>
<p class="muted">A product of ${COMPANY}, Oklahoma City.</p>
<h2>The employees</h2>
<div class="grid">${grid}</div>
<h2>How it works</h2>
<div class="steps">
<div class="st"><div class="num">1</div><b>Tell them about your business</b><p>Add your services, documents and goals to the Brain, and answer each employee's onboarding questions.</p></div>
<div class="st"><div class="num">2</div><b>They do the work</b><p>Employees write drafts in chat, on a schedule you set, or when you ask.</p></div>
<div class="st"><div class="num">3</div><b>You approve</b><p>Every email, post, calendar invite and application waits in Approvals until you press Approve, Send or Post.</p></div>
</div>
<h2>Accounts you can connect</h2>
<p>You connect accounts from the Integrations page with one button, and you can disconnect any of them at any time. When you disconnect, we revoke access and delete the stored key.</p>
${table(["Account", "What we ask for", "Why"], CONNECT)}
<p style="margin-top:16px">Read how we handle your data in our <a href="/privacy">privacy policy</a>.</p>
</main>`;
  return shell("about", "LeadDash Employees", "AI employees for your business. You approve everything they send.", body);
}

export function privacyPage() {
  const body = `<main class="doc">
<h1>Privacy policy</h1>
<p class="muted">LeadDash Employees · Effective ${EFFECTIVE}</p>
<p>LeadDash Employees is operated by ${COMPANY}, ${ADDRESS} ("we"). This policy covers employees.leaddash.io.</p>

<h2>What we collect</h2>
<ul>
<li><b>Your account:</b> your name and email address. Sign-in codes are stored only as a one-way hash and expire after 10 minutes. We record the IP address of each sign-in.</li>
<li><b>Your workspace:</b> the business details, documents and links you add, your chats with the employees, the drafts they write, your approvals and your scheduled tasks.</li>
<li><b>Hiring:</b> resumes and applications you upload. For outreach, Quinn saves work facts people published themselves, such as a license type or a practice website. Prospects nobody acted on are deleted after 90 days.</li>
<li><b>Connected accounts:</b> the details listed in the next section.</li>
<li><b>Push notifications:</b> if you turn them on, the push address your browser gives us.</li>
</ul>

<h2>Connected accounts</h2>
${table(["Account", "What we receive", "How we use it"], [
    ["Google", "The account's email address and access keys for gmail.send and calendar.events", "To send the emails you approve and add the events you approve. We do not read, store or scan your Gmail messages or calendar."],
    ["LinkedIn", "Your name, email, member ID and access keys", "To publish the posts you approve."],
    ["Facebook and Instagram", "The Pages you manage, their linked Instagram accounts and access keys", "To publish the posts you approve to the Page and account you pick."],
    ["X", "Your username and access keys", "To publish the posts you approve."],
    ["Google Business Profile", "Your listing and access keys", "To publish the updates you approve."],
  ])}

<h2>Google user data</h2>
<p>LeadDash Employees' use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<ul>
<li>We use Google data only to send the emails and create the events you approve.</li>
<li>We do not sell it, use it for advertising, or use it to train AI models.</li>
<li>We do not send it to AI services.</li>
<li>No person at LeadDash reads it unless you ask us to for support, it is needed for security, or the law requires it.</li>
</ul>

<h2>How the employees use AI</h2>
<p>Drafts are written by AI models run by our service providers. To write a draft, we send the content it needs: your request, your business details and the relevant parts of your documents. AI drafts can be wrong, which is why every draft waits for your approval.</p>

<h2>Who we share data with</h2>
<ul>
<li><b>Service providers</b> that run the app: Amazon Web Services (hosting and email), AssemblyAI and Anthropic (writing and web search), OpenAI (images), and the browser push services that deliver notifications.</li>
<li><b>The platforms you connect,</b> only when you approve something to send or post there.</li>
<li><b>Authorities,</b> when the law requires it.</li>
</ul>
<p>We do not sell personal information.</p>

<h2>How we protect it</h2>
<p>Access keys for connected accounts are encrypted with AES-256-GCM and never sent to your browser. All traffic uses HTTPS. Each workspace's data is kept separate, and only its team can see it.</p>

<h2>How long we keep it</h2>
<ul>
<li>Account and workspace data: while your workspace is active, and deleted within 30 days after it closes.</li>
<li>Connected account keys: deleted when you disconnect.</li>
<li>Outreach prospects: 90 days unless you act on them.</li>
<li>Sign-in sessions: 14 days.</li>
</ul>

<h2>Your choices</h2>
<ul>
<li>Disconnect any account from Integrations at any time.</li>
<li>Remove Google access from your <a href="https://myaccount.google.com/permissions">Google Account permissions</a> page, and LinkedIn, Meta or X access from their settings.</li>
<li>Ask us to see, correct or delete your data at <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</li>
</ul>

<h2>Children</h2>
<p>LeadDash Employees is for businesses and is not meant for anyone under 18.</p>

<h2>Changes and contact</h2>
<p>We will post changes here and update the effective date. Questions: <a href="mailto:${SUPPORT}">${SUPPORT}</a> or the address above.</p>
</main>`;
  return shell("privacy", "Privacy policy · LeadDash Employees", "How LeadDash Employees collects, uses and protects your data.", body);
}

export function termsPage() {
  const body = `<main class="doc">
<h1>Terms of service</h1>
<p class="muted">LeadDash Employees · Effective ${EFFECTIVE}</p>
<p>These terms are an agreement between you and ${COMPANY} ("we") for your use of LeadDash Employees at employees.leaddash.io. If your business has a signed LeadDash subscription agreement, that agreement controls where the two differ.</p>

<h2>Accounts</h2>
<p>LeadDash Employees is for businesses. A workspace owner adds the people on their team. You are responsible for the people you add and for keeping your email account secure, since sign-in codes are sent there.</p>

<h2>Your content</h2>
<p>You own what you add and what the employees write for you. You let us store and process it only to run LeadDash Employees for you.</p>

<h2>AI drafts and your approval</h2>
<p>Employees write drafts with AI, and drafts can contain mistakes. Nothing is sent, posted or submitted until you approve it. When you approve, you are responsible for that email, post, invite or application, including any certification an application asks you to make.</p>

<h2>Connected accounts</h2>
<p>When you connect Google, LinkedIn, Meta, X or another service, you agree to follow that service's terms. We act only on what you approve, and you can disconnect at any time.</p>

<h2>Hiring</h2>
<p>Quinn helps you find and screen candidates. You make every hiring decision and are responsible for following employment laws. Quinn never considers protected traits and never logs into LinkedIn for you.</p>

<h2>Acceptable use</h2>
<p>Do not use LeadDash Employees to send spam, mislead people, break the law, or post content you do not have the right to share. We may suspend a workspace that does.</p>

<h2>Fees</h2>
<p>Fees are set by your LeadDash plan or agreement.</p>

<h2>Ending service</h2>
<p>You can stop using LeadDash Employees at any time. We may end or suspend service for a breach of these terms. After a workspace closes, its data is deleted as described in the <a href="/privacy">privacy policy</a>.</p>

<h2>Disclaimers and liability</h2>
<p>LeadDash Employees is provided as is. We do not promise that a grant, application, post or hire will succeed. To the extent the law allows, our total liability is limited to the fees you paid in the 12 months before the claim.</p>

<h2>Governing law</h2>
<p>These terms are governed by the laws of the State of Oklahoma.</p>

<h2>Changes and contact</h2>
<p>We will post changes here and update the effective date. Questions: <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>
</main>`;
  return shell("terms", "Terms of service · LeadDash Employees", "The terms for using LeadDash Employees.", body);
}

/**
 * Registers the pages before the app's catch-all, so they never need a sign-in.
 * The site root shows About to anyone without a session (Google's home page
 * check must not land on a sign-in screen); signed-in people get the app.
 * The sign-in screen itself lives at /signin.
 */
export function registerPublicPages(app: Express) {
  app.get("/", (req, res, next) => {
    if (parseCookies(req.headers.cookie ?? "")[SESSION_COOKIE]) return next();
    res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).send(aboutPage());
  });
  const pages: Record<string, () => string> = { "/about": aboutPage, "/privacy": privacyPage, "/terms": termsPage };
  const cache = new Map<string, string>();
  for (const [route, render] of Object.entries(pages)) {
    app.get([route, `${route}/`], (_req, res) => {
      if (!cache.has(route)) cache.set(route, render());
      res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" }).send(cache.get(route));
    });
  }
}
