# LeadDash Employees

Seven AI employees, one job each, working from a shared Brain. Everything an employee writes waits in the approval queue for a person.

| Group | Employee | Job | Searches the web |
|---|---|---|---|
| Revenue | Morgan | Grants, pitch competitions and accelerators: finds them, reads the host's package, writes the application | yes |
| Revenue | Taylor | Speaking: finds calls for proposals, reads them, writes the speaker application | yes |
| Marketing | Sienna | Social media: posts, Reels and videos per platform, a content calendar, scheduling | no |
| Marketing | Theo | Blog: long-form articles and banners for WordPress | no |
| Marketing | Jordan | Website: page plans with the copy for each section | no |
| Marketing | Elena | Video: current formats turned into a shot list and script | yes |
| Operations | Avery | Inbox and calendar: what the sender wants, urgency, reply draft, calendar holds | no |

Names can be changed per workspace. The `kind` column decides what an employee does (`server/employees/roster.ts`).

## How it works

- **Sign-in:** email and a 6-digit code (sent through Amazon SES). Codes last 10 minutes, lock after 5 wrong tries, and only a hash is stored. Sessions are server-side and revoked on sign-out.
- **Who sees what:** every route requires a signed-in person who is on that workspace. LeadDash staff (`ADMIN_EMAILS`) have support access to every workspace without appearing on its team, and are the only ones who create workspaces.
- **The Brain:** the workspace profile plus every Brain entry goes into every employee's instructions on every task (`server/employees/brain.ts`).
- **Writing** goes through the AssemblyAI LLM Gateway (same key and BAA as DashNotes). **Web search** goes to Anthropic directly, because it needs Anthropic's search tool. **Images** go to OpenAI. Each is optional: if a key is missing, that employee says so instead of failing.
- **Sources:** a grant, event or trend is saved only if it carries a link from a site the search actually returned. The searches each employee ran are saved with the result.
- **Connection secrets** (client secrets, app passwords) are encrypted with `SECRETS_KEY` (AES-256-GCM) and never sent back to the browser.
- **Database:** SQLite, one file at `data/employees.db`. Migrations run on start.

## Applying (Morgan and Taylor share one engine)

`server/employees/apply.ts`. Find, score Apply / Partner / Skip, download the host's package (the page plus every PDF, Word, Excel and PowerPoint file it links to) and read it in full, pull out the questions, limits, scoring, attachments and any AI rule, write the application to the host's own questions from the Brain and Knowledge, run a separate reviewer check, then wait for the person's Submit tap (which records who certified it). Hosts that restrict AI-written applications (NIH, NOT-OD-25-132) get an outline with facts and sources instead of a draft.

- **Knowledge:** each employee has its own Knowledge tab on top of the shared Brain. Every document is split into passages and indexed (SQLite full-text search, `knowledge_fts`), so long documents are read in full. Scanned PDFs are read by Claude through the Anthropic key.
- **Uploads:** large files go to `POST /api/upload/:slot` as the raw body (Knowledge files, RFPs, signed forms, pitch videos, award letters). nginx must allow them: `client_max_body_size 300m;`.
- **Sending:** Submit marks the application approved and certified. Automatic sending through Grants.gov, Submittable, Sessionize, other portals and Gmail is not switched on yet; the person downloads the package, submits it, and presses Mark sent.

## Hiring (Quinn)

`server/employees/hiring.ts`. Roles with job posts and where to post them; outreach lists from public work profiles (LinkedIn profiles that show up in search, practice team pages, directories), each with a drafted message; resume screening against the role's must-haves only; license, NPI (NPPES Registry API), OIG exclusion list (the public LEIE file, cached monthly under `uploads/cache/`) and SAM.gov checks (needs `SAM_API_KEY`); interview, decline and offer drafts that wait in Approvals; the new hire checklist and team expirations. Quinn never logs into or automates LinkedIn, never considers protected traits or work gaps, and deletes untouched prospects after 90 days.

## Onboarding and assignments

Every employee has an Onboarding tab: fixed-choice questions about what the owner wants, "A day with ..." written from the answers, and Assignments (scheduled tasks such as "Send me a report" every day at 9:00 AM). Answers go into every instruction the employee gets. Every roster job is in every workspace; new jobs are added to existing workspaces at startup (`server/employees/roster-sync.ts`).

## One-click integrations

`server/integrations.ts`. LeadDash registers one app with Google, LinkedIn, Meta and X and puts the keys in `.env` (`GOOGLE_CLIENT_ID`, `LINKEDIN_CLIENT_ID`, `META_APP_ID`, `X_CLIENT_ID` and their secrets). Each workspace then presses Connect on Integrations; the sign-in comes back to `/api/oauth/<app>/callback` and the tokens are saved encrypted. Approve in Approvals then posts (LinkedIn profile, Facebook Page, Instagram, X, Google Business Profile), sends (Gmail, from `gmail.send` only, so no yearly Google security audit) or adds the hold to Google Calendar. Items whose channel is not connected wait, and Try again resends only what failed. Instagram and Facebook fetch images from a signed link (`/media/...`) that expires after a day.

## Sienna's planner

`server/social.ts`, `shared/post-model.ts`, `client/src/ld/work/Posts.tsx`, `client/src/ld/social/`. Sienna's Posts tab has Calendar (month and week, drag a draft onto a day), Drafts, Scheduled and Posted. One editor (also used in Approvals) sets Post or Reel, the same post everywhere or a different one per account, the accounts, the image or video and its cover, the TikTok settings TikTok requires, and the time. The preview shows each platform at its real shape: Instagram feed images are cut to 4:5 through 1.91:1 (the server cuts them the same way), Reels and TikTok are 9:16, the others show the image's own shape. Approving a post with a later time schedules it; the runner posts it when the time comes. Videos post in the background. Suggest time uses the Facebook Page's own reactions, comments and shares once it has 10 posts, otherwise common defaults. In chat, "schedule the next 12 posts on Facebook" gives a plan card (Schedule all, Other times, Open calendar); Sienna writes more drafts when there are too few.

Threads and TikTok connect like the others: `THREADS_APP_ID`, `THREADS_APP_SECRET`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, with redirect URIs `/api/oauth/threads/callback` and `/api/oauth/tiktok/callback`. Until TikTok audits the app, TikTok only allows "Only me" videos.

## App review access

LeadDash staff see an App review access card on My account. While it is on and before its end date, the review email (review@leaddash.io by default) signs in on the normal sign-in page with the fixed 6-digit code shown on the card; no email is sent. The reviewer only reaches the Demo practice workspace (sample data, made on first use), cannot change its team, and sees a bar across the top. Turning it off, a new code, or the end date signs the reviewer out; turning it off or the end date also disconnects anything they connected. Ten wrong codes lock it for 15 minutes.

## Public pages

The site root (for visitors without a session), `/about`, `/privacy` and `/terms` are plain HTML from `server/public-pages.ts`, open without signing in. The sign-in screen is at `/signin`. `/about` is the App home page listed in Google's and Meta's app settings. Change the policy text there, and update the effective date when you do.

## Phones and push notifications

The layout switches to a bottom bar under 760px. The app is installable (manifest, icons, `client/public/sw.js`). Push uses Web Push with VAPID keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`); each person turns push on per device under My account and picks what they hear about. On iPhone, push works only from the app added to the Home Screen (iOS 16.4 and later).

## Screens

Chat-first, from the approved mockup: a rail (Chats, Approvals, Tasks, Brain, Workspace, Integrations, Team), the employee list, and each employee's Chat, Work and Guidelines tabs. Chatting with an employee runs its job (find grants, write a post, draft a reply...) and the reply carries result cards. Tasks run on a schedule in the workspace time zone and post their results into the employee's chat.

## What is not built yet

- Sending through WordPress, Grants.gov, Submittable and Sessionize. Approved blog posts and applications still wait for you.
- LinkedIn company pages (needs LinkedIn's Community Management API approval) and reading your Gmail inbox (restricted Google scopes need a yearly security assessment).
- Funding facts from LeadDash EHR (monthly totals, no client data) need an endpoint on the LeadDash EHR side.
- Quinn's own portrait. Quinn uses the default portrait (`client/public/avatars/custom.webp`) until one is made; put it at `client/public/avatars/hiring.webp` and point `AVATAR_FILES.hiring` at it in `client/src/ld/meta.ts`.
- Reading candidate replies. Quinn cannot see your inbox yet, so you press Replied on Outreach.

## First-time setup on the EC2 box

Each line is one paste.

```bash
cd /home/ssm-user && git clone https://github.com/ashleybryant-ux/LeadDash-Employees.git employees
```

```bash
cd /home/ssm-user/employees && cp .env.example .env && sed -i "s|^SECRETS_KEY=.*|SECRETS_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")|" .env && for k in ASSEMBLYAI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY; do v=$(grep -h "^$k=" /home/ssm-user/server/.env | tail -1 | cut -d= -f2-); [ -n "$v" ] && sed -i "s|^$k=.*|$k=$v|" .env && echo "$k copied" || echo "$k not in the EHR .env"; done; grep -h '^AWS_' /home/ssm-user/server/.env >> .env 2>/dev/null; echo "AWS lines copied: $(grep -c '^AWS_' .env)"
```

```bash
ss -ltn | grep -q ':4100 ' && echo "4100 IN USE" || echo "4100 free"
```

```bash
cd /home/ssm-user/employees && ./deploy.sh
```

## Every deploy after that

```bash
cd /home/ssm-user/employees && ./deploy.sh
```

It pulls, installs, runs the tests, builds, boot-checks the new build on a spare port against a copy of the database, then restarts PM2 (`leaddash-employees`) and confirms the live port answers. If any step fails, the running app is left alone.

## Nightly backup

```bash
(crontab -l 2>/dev/null; echo "15 3 * * * cd /home/ssm-user/employees && node scripts/backup.mjs >> data/backup.log 2>&1") | crontab -
```

## Local development

```bash
npm install
cp .env.example .env   # fill in keys; without SES, sign-in codes print to the console
npm run dev            # http://127.0.0.1:4100
npm test
```
