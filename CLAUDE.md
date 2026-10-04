# LeadDash Employees

AI employees for a business owner: a Node + Express + tRPC server with a SQLite database (Drizzle) and a React client (Vite).

## Commands
- Install: `npm ci`
- Type check: `npm run check`
- Tests: `npm test` (Vitest; every change keeps them passing)
- Build: `npm run build`
- Database changes: edit `drizzle/schema.ts`, then `npx drizzle-kit generate --name <what_changed>` and commit the new migration.

## Where things are
- `server/routers.ts`: every tRPC procedure.
- `server/employees/`: each employee's work (chat.ts is the chat engine and its actions).
- `client/src/ld/`: the app's screens; `theme.css` holds the styles.
- `deploy.sh`: the owner runs it on the server. Never deploy anything yourself.

## Rules
- American English. Never use em dashes or en dashes in anything users read.
- Screen copy is short and plain. Buttons fit on one line. Dates include the year ("Oct 4, 2026").
- Sections show values read-only with an Edit button; Edit opens the fields with Save and Cancel. No click-to-edit.
- List rows expand in place below the row. Row buttons are the same width and line up in one column.
- Never commit keys, passwords or `.env`. Never add client or patient health information anywhere.
- Keep changes small and in the style of the code around them. Add or update a test for what you change.
