# LeadDash Employees

Seven AI employees, one job each, working from a shared Brain. Everything an employee writes waits in the approval queue for a person.

| Group | Employee | Job | Searches the web |
|---|---|---|---|
| Revenue | Morgan | Grants: finds open grants with sources, drafts the proposal | yes |
| Revenue | Taylor | Speaking: finds events taking proposals, writes the pitch | yes |
| Marketing | Sienna | Social media: posts per platform plus the image | no |
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

## Screens

Chat-first, from the approved mockup: a rail (Chats, Approvals, Tasks, Brain, Workspace, Integrations, Team), the employee list, and each employee's Chat, Work and Guidelines tabs. Chatting with an employee runs its job (find grants, write a post, draft a reply...) and the reply carries result cards. Tasks run on a schedule in the workspace time zone and post their results into the employee's chat.

## What is not built yet

- Sending. Approving an item marks it approved; nothing goes to Gmail, Google Calendar, LinkedIn, Meta, X or WordPress yet. That is round 2 and needs each provider's developer app.
- Employee portraits. Put them in `client/public/avatars/<kind>.png` and list them in `client/src/ld/meta.ts` (`AVATAR_FILES`).

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
