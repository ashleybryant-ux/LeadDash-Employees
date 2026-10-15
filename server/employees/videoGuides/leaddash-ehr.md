# LeadDash EHR

A guide for recording demo videos, training videos and written SOPs of the LeadDash EHR web app. Every label here was read from the app's code on Oct 12, 2026. If a screen on the day looks different from this guide, trust the screen, note the difference, and tell Ashley.

This guide says where things are and what the labels mean. It is not a list of the only videos that can be made: every screen in it, and every task a practice does on one, can be a video, and the way to plan any of them is to open the screen in the demo and walk it top to bottom, naming every part and every option, before writing the steps. The tasks at the end are worked examples of that.

How to read this guide:

- Labels in **bold** are the exact words on the screen. Click or type exactly what is in bold.
- A path such as `/calendar-view` is the part of the web address after the host. In the demo the full address is `https://demo.leaddash.io` followed by the path.
- "Card" means a white box on a page with a heading. "Row menu" means the **⋯** button at the right end of a list row.
- Most sections show values read-only with an **Edit** button. **Edit** opens compact fields with **Save** and **Cancel**. Clicking a value never starts editing.
- Most list rows open in place: click the row or its arrow, and the details appear right under it.

## Where and how

### The only place to work: the demo

- Web address: **https://demo.leaddash.io**
- The demo is the real LeadDash EHR app, running against a fictional practice called **Maple Crest Counseling**. Every client, note, claim and payment in it is made up and is built inside your own browser tab. Nothing you do in the demo reaches the LeadDash server, a payer, a clearinghouse, a phone or an inbox.
- A dark bar runs along the bottom of every demo screen. It reads **DEMO**, then "Maple Crest Counseling is a fictional practice. Nothing here is real and nothing you do is saved." On the right it has **What to look at**, **Start over** and **Start your practice**.
- The same fictional practice also exists inside the live app, at **https://ehr.leaddash.io**, as the Demo Account. It is filled with the same kind of made-up data (Maple Crest Counseling, its six team members, 30 fictional clients), and there your changes are saved, so a video can show a whole task end to end. You sign in there as one of its team (Sarah Chen, Marcus Ortega, Priya Bell, Alicia Grant, Rosa Delgado or Tom Nakamura) with the email Ashley gives you; the site sends a sign-in code, which Ashley pastes in when you ask. Right after signing in, read the practice name at the bottom of the left menu: it must say **Maple Crest Counseling**. If it says any other practice, stop at once and tell Ashley; never work in it.
- Never use any other practice in the live app, and never any LeadDash address other than demo.leaddash.io and ehr.leaddash.io. The live app holds real practices and real clients.

### How you get in

The demo opens with a sign-up card ("Open the demo", with First name, Last name, Work email, Mobile, Practice name and "Clinicians at your practice"). That form is real: it sends the details to LeadDash as a sales lead tagged "received demo". Do not fill it in.

Instead, the team link is used on its own: LeadDash Employees keeps the demo's team code on the server and opens every demo recording through `https://demo.leaddash.io/?team=<code>`. The sign-up card is skipped, the code is dropped from the address bar, and the app opens on the **Dashboard**, already signed in. You never type a password or a code in the demo, and you never ask anyone for the team link. If the sign-up card shows anyway, the team code is not saved on the server: stop and tell Ashley.

### Popups, and how to get past them

A popup is a box or panel drawn over the page. Nothing behind it can be clicked until it is closed. The recording does not continue on its own: close the popup, then go on with the step.

| What you see | What to do |
|---|---|
| A dark message box that starts "In your own account this would..." | The demo explaining what a real account does at that moment (sending a claim, taking a payment, opening a video session). Press Escape or click outside it. The step counted; go on. |
| The DashNotes recorder window ("Ready to record") after **Start recording** | Click **Start recording**, wait a few seconds, click **End and draft note**, wait for "Your draft is written", then click **Close**. The note's fields behind it are filled in. |
| A form the step opened on purpose (Add appointment, a payment, a claim) | Finish it inside the popup and close it with its own button (**Save**, **Book**, **Submit**), never by clicking outside. |
| A notice, tip or "Where to start" card the step did not ask for | Close it with its **Close**, **Got it**, **OK** or **X** button, or press Escape, then go on. |
| A browser alert ("Claim saved with 'Ready' status...") | The browser closes it on its own. Nothing to do. |

Who you are in the demo: **Sarah Chen**, LPC, practice administrator. The bottom of the left menu shows "Signed in as", "Sarah Chen", "Maple Crest Counseling · Administrator", and a **My account** link. Because you are an administrator, you see every menu item a practice owner sees.

### What sample data the demo has

The data is generated fresh, relative to today's date, every time the demo loads. Today always has sessions, some notes are overdue, and claims are in every state.

Practice

- Maple Crest Counseling, 2400 Maple Crest Drive, Suite 210, Oklahoma City, OK 73134, phone (405) 555-0100.
- Two places sessions happen: **Telehealth** and **Maplecrest office**.
- Closures already on file: Thanksgiving (every location) and an "Office painting" day about nine days from today (office only).

Team

| Name | Role in the demo |
|---|---|
| Sarah Chen, LPC | You. Administrator and clinician. Supervises Alicia Grant. Has two telehealth rooms. |
| Marcus Ortega, LCSW | Clinician. Has a telehealth room. |
| Priya Bell, LMFT | Clinician. Runs her video sessions on Google Meet, not a LeadDash room. |
| Devon Hart, LMFT | Clinician. |
| Alicia Grant, LPC candidate | Supervised clinician. Her notes need Sarah's co-signature. |
| Rosa Delgado | Practice administrator and billing. No caseload. |
| Tom Nakamura | Front desk. No caseload. |

Clients

- 30 fictional clients, 26 active and 4 inactive. Each has a phone in the (405) 555 range and an example.com email.
- Payers are spread across clients: UnitedHealthcare, Blue Cross Blue Shield of Oklahoma, Aetna, Cigna, Self-pay, ComPsych EAP and Spring Health EAP.
- Handy clients for videos:
  - **Adrienne Fowler**: UnitedHealthcare, sees Sarah Chen, telehealth.
  - **Marcus Whitfield**: Blue Cross Blue Shield of Oklahoma. His birthday is always today, so the birthday confetti icon shows next to his name.
  - **Priscilla Nakamura**: Self-pay, sees Alicia Grant, in the office.
  - **Terrence Bright**: ComPsych EAP (an employer program with a set number of sessions).
- One client in the demo is named Simone Vasquez. That is a fictional client, not you.

Sessions, notes and money

- Weekly sessions from six weeks ago to four weeks ahead, every day of the week, between 9 AM and 4:30 PM. Today always has several.
- Four services: Initial Intake Assessment (90791, 60 minutes), Individual Therapy For Adults (90837, 53 minutes), Couples Therapy (90847) and Skills Group (90853).
- Past sessions have signed progress notes, except the six most recent, which show **Needs note**.
- Claims exist for insured clients' signed sessions: recent ones **Submitted**, older ones **Paid**, one **Rejected** ("Subscriber ID does not match payer records") and one **Denied** ("CO-197 Precertification absent").
- Sessions from the last two days have no claim yet, so they wait on the **To be submitted** tab.
- Client invoices in every state (paid, partly paid, sent, a few drafts), card and cash payments, and some clients with $40 of credit not yet applied.
- Two groups: "Anxiety skills group" and "Grief and loss support".
- 14 conversation threads (texts, emails, calls), 7 faxes (one waiting to be filed), open staff tasks, three treatment plans waiting on signatures, and one signed school letter.

### Resetting and adding sample data

- **Start over** in the bottom bar wipes everything you changed and reloads the original sample data.
- Reloading the page (the browser's reload button, or anything that loads a whole new page) also resets the demo. Plan each video as one unbroken take inside one tab.
- Opening the demo in a second tab starts a separate, fresh copy.
- You can add sample data the normal way (add a client, book a session, write a note), but it lasts only until the next reload or **Start over**. There is no way to save sample data permanently.

### What the demo cannot show

The demo answers the app's requests inside your browser. When something would leave the practice in real life, the demo shows a notice that starts "In your own account this would..." and then lets the screen carry on. This happens for: starting a LeadDash video session, creating a telehealth room, submitting or saving a claim to the clearinghouse, sending a payer enrollment, taking a client payment through the payment screen, and emailing an invoice.

Verified gaps in the demo (do not plan a video that depends on these):

- **Add insurance payment** page (`/insurance/payment/new`): lists no sessions in the demo. You can show the page and its fields, but not a full posting.
- Insurance payments saved on a chart row show their "Insurance payment saved..." line, but the demo does not keep them, so the row's numbers do not change.
- Couples charts: the demo has none, and **Create couples chart** does not work in the demo.
- Treatment plans: plans already on a chart show, but the builder's library suggestions are empty and a new or changed plan is not kept.
- **Check eligibility** and **Check again**: show the earlier result on file; the demo does not ask a payer again.
- **Send fax**: nothing is sent and the Sent list does not grow.
- **Receptionist** and **Community** open outside pages, not demo content. Do not record them in the demo.
- Other saves the demo does not handle "succeed" quietly with no change on screen. If a save shows no result, do not reload to check; note it and move on.

## The menu

The left menu (sidebar) has the LeadDash EHR logo at the top and an arrow button that shrinks the menu to icons. Items appear in this order for an administrator. Other people see only the items their role allows.

**YOUR PRACTICE** (everyone)

| Item | Path | What it is for |
|---|---|---|
| Dashboard | `/index` | Your day: today's sessions, your to-do list, recent sessions and their notes. |
| Calendar | `/calendar-view` | The practice calendar: book, move, edit and cancel sessions; set availability; events and time off. |
| Patients | `/patients` | The client list, adding clients, couples charts. Each client opens their chart. |
| Groups | `/groups` | Standing therapy groups and their members. |
| Appointments | `/appointments` | Lists of sessions: Needs note, Upcoming, Past, Cancellations, Reschedule requests. |
| Conversations | `/conversations` | The practice inbox for client texts, emails and calls. Shows an unread count. |
| To sign | `/to-sign` | Notes and plans waiting on a signature. Shows a count. |

**MONEY** (administrators and billing roles)

| Item | Path | What it is for |
|---|---|---|
| Insurance | `/insurance` | The Claims center: To be submitted, Claims, Unpaid claims, Payments, Client owes. |
| Billing, then Overview | `/billing` | Money received, deposits, refunds, unapplied payments, invoices. |
| Billing, then Invoices | `/billing/invoicing` | Client invoices and sessions not yet invoiced. |
| Fax | `/fax` | Faxes received and sent. Shows a count of faxes waiting to be filed. |
| Reports | `/reports` | Opens a submenu of seven reports. |
| Reports, then Overview | `/reports` | Collections at a glance. |
| Reports, then Income | `/reports/income` | Money received, from clients and from insurance. |
| Reports, then Outstanding | `/reports/outstanding` | What is owed, by age. |
| Reports, then Claims | `/reports/claims` | Claims filed, paid, denied, still out. |
| Reports, then Sessions | `/reports/sessions` | Care delivered and how it was billed. |
| Reports, then Provider collections | `/reports/collections` | What each clinician collected, for payroll. |
| Reports, then Caseload | `/reports/caseload` | Every client with status, for audits. |
| Payer Enrollment | `/admin/claimmd/enrollment` | Getting the practice enrolled with each insurance payer. |

**GROW** (administrators)

| Item | Path | What it is for |
|---|---|---|
| Receptionist | `/receptionist` | The practice's AI receptionist, an add-on. Not for demo recording. |

**SETUP** (administrators)

| Item | Path | What it is for |
|---|---|---|
| Setup checklist | `/setup` | What is set up, what is left. |
| Practice Settings | `/calendar-settings` | All settings pages (listed below). |
| Audit Trail | `/audit-logs` | The record of who did what and when. |

**No heading** (everyone)

| Item | Path | What it is for |
|---|---|---|
| Community | `/community` | The LeadDash members' community. Not for demo recording. |
| Mobile App | `/mobile-app` | How to install LeadDash EHR on a phone, tablet or computer. |

Below the menu: "Signed in as", your name, practice and role, the **My account** link (`/account`), and the orange **Log out** button. In the demo, do not press **Log out**.

### Practice Settings pages

**Practice Settings** opens a page titled **Settings** with a numbered list on the left. Click a name to open it on the right. Each page has **Back:** and **Next:** buttons at the bottom to step through them in order. You can also open one directly with `/calendar-settings?section=` and the id in the second column.

| # | Group | Page | Id | What it is for |
|---|---|---|---|---|
| 1 | Your practice | Practice info | practice | Name, address, contact, logo, billing identifiers, email to clients, consent form details, copays. |
| 2 | | Locations | locations | The office and video "places", place of service codes, closures. |
| 3 | | Team | team | People, roles, what they can see, credentials, supervision, hours. |
| 4 | What you offer | Client forms | client-forms | Intake forms, consents, measures, packets. |
| 5 | | Services | services | Codes, rates, lengths, who offers each service, online booking. |
| 6 | | Note templates | templates | The note formats clinicians write in. |
| 7 | | Letter templates | letters | The letters clinicians write for clients. |
| 8 | Clients | Portal and booking page | portal | The client portal address, the booking page, live previews of both. |
| 9 | | Telehealth | telehealth | Video rooms for each clinician. |
| 10 | | Client messages | reminders | Reminders, notices, quiet hours, missed-session follow-up, staff notifications, morning summary. |
| 11 | | HIPAA-compliant phone | phone | The practice's number for texts and calls. |
| 12 | Money | Payments and invoices | payments | Stripe card payments and when invoices are created. |
| 13 | | Insurance | insurance | Claims identifiers, supervised claims, eligibility checks, payers. |
| 14 | Other | Fax | fax | The practice's fax line. |

A page named **LeadDash Employees** can also appear after Team, only when LeadDash staff have turned it on for a practice.

### Header (top bar, every page)

From left to right: **Search clients...** box, (for people who can see billing) an **Income** figure for this month, **Add appointment**, **My room** (only for a clinician with a telehealth room), **Privacy** (turns privacy mode on and off), and a full-screen button.

- **Search clients...**: type two or more letters, then click a name to open that chart. Caution in the demo: this opens the chart by loading a whole new page, which resets the demo. To keep your changes, open charts from **Patients** instead.
- **Add appointment**: opens the Add appointment window from any page.
- **Privacy**: when on, it reads **Privacy on** and client names show as an initial and surname. A **show** link next to a chart's name reveals that one name.

## Screens

### Dashboard

Path: `/index`. What it is for: one screen with your day and what is waiting on you.

What is on it, top to bottom:

- A live session bar, when a session is happening now or next: "Your session with [client] is happening now" or "[client] [is next / in ...]" with **Join session**, **Open room**, or **Open chart**. In the demo, **Join session** and **Open room** open a real outside web page; do not click them on camera.
- A line of figures, each clickable: **Sessions today**, **Sessions this week, Sun to Sat**, **Sessions completed, last 30 days**, **Notes not written, last two weeks**, and (when it applies) **Notes waiting on your co-signature** or **Your notes out for co-signature**.
- **To do** card. A summary line ("2 overdue, 1 due today, 3 due this week") and a **Notes this week** meter. Four tabs: **Notes**, **Co-signature**, **Treatment plans**, **Tasks**, each with a count, plus **+ Add task**. Items are grouped **Overdue**, **Due today**, **Due this week**, **Later**, 10 per page with **Previous** and **Next**.
  - Notes rows: client name, "Progress note" tag, session time, and **Write note**.
  - Co-signature rows: **Review and sign** (a supervisee's note), or for your own notes **Fix and resend** (sent back) or **View**.
  - Treatment plans rows: **Finish and sign** (draft), **Start review** (review due), **Start plan** (no plan yet). These open the chart's Clinical tab.
  - Tasks rows: **Chart** and **Done**.
- **Schedule** tabs: **Today**, **This week**, **Past two weeks**.
  - Today ("Your day"): each session with time, client, service, clinician, status pill, and for past sessions **Note added** or **Write note**. Video sessions show **Open room** or **Join**. Links: **Full calendar**, **Back to today** (when viewing another day).
  - This week: table with Client, When, Calendar, Status, Chart; **Previous** and **Next** to change week.
  - Past two weeks: table with Client, When, Status, Note (**Added** or **Missing**), and **View note** or **Write note**.
- A small month calendar on the right; click a date to see that day under Today.

Add task window: title **Add task**. Fields: **What needs doing** ("For example: call about FMLA paperwork"), **Client (optional)** ("Search clients"), **Due**, **For** (who it is for), **Notes (optional)**. Buttons **Cancel** and **Add task**.

Source: template/src/pages/dashboard/UserDashboard.tsx, template/src/components/AddTaskModal.tsx

### Calendar

Path: `/calendar-view`. What it is for: seeing and changing the practice schedule.

Top: title **Calendar**, buttons **Refresh** and **Add appointment**.

Control bar:

- **Today**, previous and next arrows, and the date range.
- **Clinicians:** picker (administrators): tick people, then **Everyone**, **Only me**, or **Done**. Picked people show as colored chips with an x to hide each.
- Service filter: **Any service** or one service.
- Status filter: **All statuses**, **Confirmed**, **Showed**, **No show**, **Late cancellation**, **Clinician cancellation**, **Cancelled**.
- View: **Day**, **Week**, **Month**.
- **Availability**: switches to the availability editor (see below). Click it again to go back to the week.

When one clinician is picked, a legend shows **Availability** with **Open**, **Booked**, **Not working**, and "Click an open slot to book it."

Clicking an empty time on the grid opens a small window titled "Add to the calendar" with three tabs:

- **Appointment**: "Continue to Add appointment with [day] at [time] filled in." Button **Continue** opens Add appointment with that day and time.
- **Event**: **Title** ("For example: Supervision"), date, start and end or **All day**, **Repeats every week** for a number of weeks, **Private, so others see "Busy"**. "Events block this time from booking." Buttons **Cancel**, **Save**.
- **Out of office**: **From**, **To**, **All day**, **Memo (optional)** ("For example: Vacation"), **Cancel appointments during this time**, and under it **Let the clients know**. Buttons **Cancel**, **Save**.
- Administrators also see **Team member** to choose whose calendar.
- Clicking an existing event opens the same window with **Delete**.

Overlapping sessions are drawn side by side. When a week is empty, the empty notice has **Add appointment** and **Event or out of office**.

Clicking a session opens its card (a pop-out):

- Top: client name, a status button (click it for **Update status** with **Confirmed**, **Showed**, **No Show**, **Late Cancellation**, **Cancelled**, **Reschedule requested**, **Clinician Cancellation**), a Minor or Adult tag, an edit icon and a close icon.
- A colored line when the client acted: "Confirmed by client by text...", "Cancelled by client in the portal...", "Reschedule requested...", or who on staff set a cancellation.
- Video session: **Start video session** (a LeadDash room) or **Open [platform]** (an outside link such as Google Meet), **Copy client link** or **Copy link**, **Send link**. After a signed note the first button reads **Rejoin video**.
- In-person session from today on: **Send session details**.
- A session today: **Remind now**, which opens "Remind [first name] now" with the message, text and email ticks, **Cancel** and **Send reminder**.
- **Edit appointment**.
- Insurance line: payer, Active or Inactive, copay and deductible, **Check again**.
- Details: **Service**, **With**, **Location**.
- **Note** with a status pill (**Needs note**, **Signed [date]**, **Awaiting supervisor signature**, **Returned for edits**, **Draft**) and the matching button: **Add note**, **Start note taker**, **Finish note**, **Fix and resend**, **Review**, or **Open note**. "Previous notes:" links, or "First session".
- **Also booked**: the client's next sessions, **See all**, **Show fewer**, **Print**, **Send to client**.
- **Billing**: **Fee**, **Claim** (**With insurance** or **Answered**), **Client owes**, **Invoice**, **Client balance**, **Card on file**, and **Take payment** when the client owes.
- Bottom: **Delete appointment** and **Open chart**.

Deleting: **Delete appointment** asks first. If the session has a charge, it reads "Delete this session and its billing?" and explains the charge and invoice go with it. If a payment is on its invoice, it says so. Buttons **Keep it** and **Delete session** (or **Delete**).

Moving a session: press and drag a session to a new time. A window asks "Move [client] to [new time]?", shows "From [old time]", warns if the new time is outside availability ("You can move it anyway."), and has **Let [first name] know** (a text and an email with the new time). Buttons **Put it back** and **Move** (or **Move anyway**).

Availability view: a week grid of each clinician's open hours. Controls: **Clinician**, **Show** (**All my hours** or **By service**), **Service**, **Location**, **Previous**, **Today**, **Next**. Click an empty part of a day to add hours; click a block to edit it. The side panel (**New availability** or **Edit availability**) has **Name**, **Hours** (from, to, **Remove this window**), **When** (**Every week** or **One day only**, with a date typed as MM/DD/YYYY), **Applies to** (services by location, **Select all**, **Clear**), and **Save**, **Cancel**, **Remove**. Below the grid, **One-off days** lists days open once, each with **Edit**.

Source: template/src/pages/calendar/CalendarView.tsx, template/src/components/scheduling/CalendarBlockPanel.tsx, template/src/pages/calendar/AvailabilityEditor.tsx

### Add appointment window

Opened from the header, the calendar, or a chart's **Schedule** button. Title **Add appointment** (or **Edit appointment** when editing). Four numbered steps:

1. **Who**: "Start typing a name or email", then pick a client. The client shows with date of birth and age as MM/DD/YYYY (age), and a confetti icon on their birthday. **Change** picks someone else. For an insured client, an **Insurance benefits** box shows Active or Not active, when it was last checked, **What the client pays**, **Deductible**, **Prior authorization**, **Client owes today**, and **Check eligibility** or **Check again**.
2. **What**: **Clinician** ("Pick a clinician"), **Where** (chips such as **Telehealth** or an office name), **Service**. The app then fills **Calendar**, **Code** (with a **change** link), **Fee** and **Place of service**. "Filled in from this client's default appointment" shows when the chart has one.
3. **When**: a month calendar (dots show days the clinician has openings), **Start**, **Length**, and the clinician's openings as time buttons, with **All**, **Morning**, **Afternoon**, **Evening** on busy days. If you pick a time outside availability, an amber warning explains why and says "Book anyway, or pick another time." An overlap shows a similar warning. **Repeat** (not for couples) with **Every week**, **Every 2 weeks** or **Every month**, for 4 to 24 sessions.
4. **Notes** (optional): "Anything the clinician should know before the session. Not shown to the client." **Send the client a confirmation by email and text**. **＋ Billing comment (rarely needed)**.

Bottom: a one-line summary, **Cancel**, and **Create appointment** (or **Create [n] appointments**, **Book anyway**, **Book [n] anyway**). When editing: **Let [first name] know about the change** and **Save changes** (or **Save anyway**).

Staff can always book outside availability. The app warns and never blocks.

Source: template/src/components/scheduling/AddAppointmentModal.tsx

### Patients

Path: `/patients`. What it is for: finding, adding and organizing clients.

Top: title **Patients**, view buttons **All patients**, **My patients**, **Couples**, and buttons **Add client** and **Sync now**. (An administrator may also see **Copy insurance from LeadDash platform**.)

Filter bar: search "Search by name, email or phone", **All clinicians** (with counts), status (**Active**, **Inactive**, **Active and inactive**, **Excluded from LeadDash EHR**), pays by (**Insurance and self-pay**, **Insurance**, **Self-pay**, **Not set**), sort (**Sort by name**, **Sort by clinician**, **Sort by date added**), and a count.

List columns: Patient, Status, Pays by, Clinician, Phone, Email, Added, and a **Chart** link. Tick boxes select rows (**Select this page** ticks all on the page). With rows ticked, a bar shows: **Assign to...** then **Assign**, **Make a couples chart** (exactly two ticked), **Make active**, **Make inactive**, **Exclude from LeadDash EHR** (or **Bring back to LeadDash EHR**), **Clear**.

Add client window: title **Add a client**. **First name**, **Last name**, **Email**, **Phone**, **Date of birth**, **Clinician** ("Not assigned" or a name). An email or a phone is required. Buttons **Cancel** and **Add client**. On success the new chart opens.

Couples view: "[n] couples charts" and **New couples chart**. The window **New couples chart** has **Choose a client**, **Partner** (**Someone new** or **Already a client**), **Billing** (**Insurance** or **Self-pay**), **Whose insurance is billed**, and **Cancel**, **Create couples chart**. (Does not work in the demo.)

Source: template/src/pages/patients/patients.tsx, template/src/pages/patients/AddClientCard.tsx, template/src/pages/patients/CouplesPanel.tsx

### Client chart

Path: `/patients/` followed by the client's id, for example `/patients/demo_pt_1`. Add `?tab=` and a tab id to open a tab: demographics, clinical, medications, insurance (shows as Coverage), billing, files, communication.

Header:

- Breadcrumb **Clients** / client name.
- Name, pronouns, **Active** or **Inactive**, **Insurance** or **Self-pay**, and a texting pill when texts cannot go out.
- Facts line: Age, Born, phone (click to dial), email. When nothing is booked: **No upcoming session** and **Schedule one**.
- Buttons: **Schedule** (opens Add appointment with this client) and **⋯** with **Upload a file**, **Add task**, **Edit client details**, **Mark inactive** (or **Mark active**).
- Flags when they apply: **Minor**, "[n] missing for billing", **Intake changes to review**, and a session authorization count such as "EAP: 3 of 6 left".
- **Admin note** band: one line for the office, **Show more** or "[n] notes", add and **Remove**.

Tabs: **Overview**, **Demographics**, **Clinical**, **Medications**, **Coverage**, **Billing**, **Files**, **Communication**. Counts appear on Overview (visits), Demographics (missing fields), Billing (unpaid invoices) and Files.

Right-hand column (on most tabs): **Upcoming** (next sessions, **Schedule**, **Print**, **Send to client**), **Balance** (unpaid invoices, With insurance, credit not applied, cards on file, AutoPay, link **Billing**), **Insurance** (link **Coverage**), **Diagnosis** (link **Clinical**), **Tasks** (**Add**, **Open**).

Source: template/src/pages/patients/patientDetails.tsx, template/src/pages/patients/AdminNotes.tsx

#### Overview tab

- **Quick chart note**: "a call, an email, anything outside a session", with **Date**, **Time**, and **Add note**.
- Period filter: **All records**, **Past 30 days**, **Past 90 days**, **Past 6 months**, **Past year**, **Custom range**.
- "[n] visits · [n] forms" and the **New** button with: **Visit**, **Progress note**, **Diagnosis**, **Letter**, then under **Plans**: **Treatment plan**, **Case management plan**, **Recovery and wellness plan**, **Safety plan**, **Relapse prevention plan**, **Discharge and transition plan**.
- The visit list, newest first. Each visit shows date, service, and a note pill: **Needs note**, **Note unsigned**, **Signed**, **Awaiting supervisor signature**, **Returned for edits**, **Draft**, **Entered in error**, or **No show** or **Cancelled**. Buttons on the row: **Add note**, **Open note**, **Review**, **Fix and resend**, **Finish**, **View**. Completed forms and scored measures appear by date too; a packet still out shows **Remind again**. **More** on a row has **Edit details**, **Download PDF**, **Delete visit**.
- **New**, then **Visit** opens **Add a visit**: **Date**, **Start**, **Stop**, **Service** ("From your Services list. Sets the code and the fee."), **Provider**, **Fee**, **Billed to**, **Delivered** (**In person (office)**, **Telehealth, client at home**, **Telehealth, client elsewhere**), **Status** (**Showed**, **No Show**, **Late Cancellation**, **Clinician Cancellation**), **Calendar**, **Put it on the calendar** (off for a past date). Buttons **Cancel** and **Book visit**.

#### Demographics tab

Cards **Caseload status** (Active since, or Inactive) and **Client details** with **Edit**. A table compares each field **On file** with **From intake** when a client's intake form proposed changes. "Everything a claim needs is on file" shows when billing details are complete.

#### Clinical tab

- **Diagnoses**: **History** (or **Hide history**), **Add** (fields **Code**, **Description**, **Make this the primary diagnosis**, buttons **Cancel**, **Add**). Each diagnosis has **Edit**, which shows **Make primary**, **No longer applies**, **Entered by mistake**, **Cancel**.
- **Treatment team**: **Edit** shows **Person**, **Role**, **Add**, and **Remove** on each member. The assigned clinician reads "Set by the calendar". **Done** closes it.
- **Plans**: **+ New plan** (the six plan kinds), **Open plan** (or **Close plan**), **Start review**, **Earlier versions**. One tab per plan kind on file. A plan shows its problem, status pills (signed count, **Review due**, **Review overdue since**, **Review in progress**), who has signed, goals and objectives.
- **Measures over time**: tiles for each scored measure, **Send a measure**. Click a tile to see results over time; click a point to open that result (**Previous result**, **Next result**, **Print**, **Close**).
- **Paperwork**: the three newest forms with **Signed** or **Waiting**, **View** or a remind button, and buttons **Send form** and **See all** (both go to Files).

The plan editor (from **Open plan**):

- With no plan: **Start a plan** offers **LeadDash builder**, **Write my own**, **One box**, and **Cancel**.
- Builder and Write my own walk five steps for a treatment plan: 1 **Diagnosis** ("From the chart"), 2 **Presenting problem**, 3 **Goals and objectives** (with **Target date** and **Fill target dates, two weeks apart**), 4 **Interventions**, 5 **Schedule and sign** (**Frequency**, **Review in**, **Co-signed by**, **Client signature**). Buttons **Next: interventions**, **Next: schedule and sign**, **Save draft**, **Sign plan**, **Cancel**. Other plan kinds use their own step names (for example Needs, Focus areas, Parts of the plan).
- One box: **Problem** and **The plan** as one text.
- Top buttons: **Preview**, **Print**, **Download PDF**, **Save draft**, **Cancel**, **Review this plan**.
- **Sign plan** opens **Sign treatment plan**: "Type your full name to sign", **Cancel**, and the sign button.
- Signatures area: **Sign**, **Remind**, **Resend to portal**, **Print for signing**, **Record a paper signature** (fields **Whose signature**, **Name as signed**, **Signed in the office, copy uploaded to Files**, buttons **Cancel**, **Record signature**).

#### Medications tab

The client's medication list, with the check and the prescriber sign-off. (Mostly used by prescribing practices.)

#### Coverage tab

Left column:

- **Default appointment**: **Edit** sets the client's usual **Clinician**, **Where** and **Service**; **Remove default**.
- **Billing**: **Edit**. Read view: **Sessions are billed to**, **Client pays**, **Sliding scale**, **Since**. Edit: **Sessions are billed to** (**Insurance** or **Self-pay**) and **Since** (MM/DD/YYYY), **Save**, **Cancel**.
- **Session authorization**: for EAPs, vouchers, pre-authorizations and grants. Fields **Type** (**EAP**, **Voucher**, **Pre-authorization**, **Grant funded**), **Sessions authorized**, **Who authorized it**, **Authorization number**, **Expires**. It counts sessions used and warns "No sessions left." or "This authorization has expired."

Right column:

- **Insurance coverage**: **Ready to file** or "Needs ..." pill, **Edit** then **Cancel** and **Save**. Fields: **Insurance carrier** ("Search 8,000+ insurance payers"), **Payer ID**, **Member ID**, **Group number**, **Policy holder name**, **Relationship to policy holder** (**Self**, **Spouse**, **Child**, **Other**), **Copay per session**, **Deductible remaining**, **Coinsurance**.
- **Insurance card**: front and back images, **Replace**.
- **Insurance benefits**: Active or Not active, **Check again** (or **Check eligibility**), what the client pays, what is left this year, mental health benefits in and out of network, history.
- **Secondary insurance**.

#### Billing tab

Top figures: **Client owes**, **With insurance**, **Credit on file**, and the **+ New** button:

- **Invoice** ("from ticked sessions or blank"), **Statement** ("a date range"), **Superbill** ("for the client to submit")
- **Record payment**, **Pay by card**
- **Add insurance payment**, **Start a claim**

When credit is sitting unused, a line reads "[amount] in payments is not on a session." with **Apply to oldest**, then **Apply**.

Sub-tabs: **Activity**, **Invoices**, **Statements and superbills**, **Claims**. Filters: **Show** (**View all**, **Sessions**, **Paid**, **Unpaid by client**, **Unpaid by insurance**, **Uninvoiced**, **Client payments**, **Insurance payments**, **Unapplied**) and **Period** (**This year**, **Last 90 days**, **All time**, **Custom dates**).

Activity table: Date, Item, Fee, Client, Insurance, Write-off. Fee always equals Client plus Insurance plus Write-off. Click a row's arrow to open it in place. The open row shows the session (Date of service, Service, Rate, Units, Provider, Billed to, Modifiers, Copay), its charge and invoice, and buttons **Decide client share**, **Edit**, **Add payment**, **Pay by card**, **Edit invoice**.

Row menu (**⋯**), only what applies:

- **Decide client share**: the payer paid part and did not say why. Type the write-off; **Save decision**.
- **Add insurance payment**: type **Insurance paid** and **Write-off** in the row's cells, then under the row **Paid on** (MM/DD/YYYY), **Check #**, **Payer** (filled in), and **Save insurance payment**.
- **Undo insurance payment**: **Why it is undone**, then **Undo insurance payment** (or **Undo this one**).
- **Add payment**: type the amount in the Client cell, then **How it was paid** (**Cash**, **Check**, **Bank transfer**, **Card, taken elsewhere**, **Other**), **Date received**, **Reference**, and **Record $[amount]**.
- **Create invoice**
- **Write off**: amount and **Why**, then **Write off $[amount]**.
- **Void invoice**: **Why it is voided**, then **Void [invoice]**.
- **Delete visit** (only for visits added by hand)
- **View details**

Every open row has a **Cancel** button in place of the **⋯**.

Invoices sub-tab: Invoice, Date, Amount, Balance, Status, and **Open**, **Edit invoice**, **Void invoice**.

Statements and superbills sub-tab: Created, Document, Covers, Amount, Sent, with **View**.

The statement window (from **+ New**, **Statement** or **Superbill**): **Generate a statement**, "Every invoice, payment, and credit in the range you pick." **From**, **To**, then **Generate statement** and **Email to client**. The superbill part: "For the client to submit to their insurer" and **Generate superbill**.

**Record payment** opens **Add payment**: **Amount**, where it goes (**Oldest unpaid invoices** or **Hold as credit**), **How they are paying** (**Card on file**, **Another card**, **Cash**, **Check**), **Check number**, **Note for the ledger (optional)**, and **Record payment** (or **Charge card**).

**Pay by card** opens **Pay by card**: credit on account, cards on file, **Which card to charge**, **Amount**, and the history with **Refund**.

#### Files tab

Folder tabs with counts: **All**, **Forms**, **Letters**, **Shared**, **Insurance cards**, **Imported**. Search box. Buttons: **Fax**, **Share**, **Send form**, **Upload** (on Forms only **Send form**; on Letters only **New letter**).

- **Send form** opens a panel with **Forms to sign** and **Files to share**. Tick forms or packets, choose **Send by** (**Text**, **Email**, **Both**), then **Send [n]**. "First paperwork: a welcome email with sign-in goes out as well" shows for a client's first packet.
- **Share** ticks files kept on the chart, **Tell [first name] new documents are in their portal**, then **Share [n]**.
- File row menu: **Download**, **Print**, **Stop sharing**, **Rename**, **Change category**, **Fax**, **Delete**.
- Upload asks for **Name** and **Category** (Insurance card, Photo ID, Referral, Outside records, Consent or release, Invoice or statement, Fax, Letter, Other).

#### Communication tab

- **How to reach them**: **Edit**. Text (**Texting** On or Off, how they consented: **Telling us in person**, **Telling us by phone**, **Signing a form**), Email, **Prefers** reminders by text or email, **Voicemail** (**OK to leave a message** or **Do not leave a message**), **Portal** (last sign-in or **Never signed in**, **Remove all devices**, **Send a sign-in link**, **Send welcome email**).
- **This client's portal**: **Edit** sets what this one client sees (**Practice default**, **Shown**, **Hidden**).
- **Messages**: the thread with this client, **Open in Conversations**, and a reply box (Text or Email, Subject for email, **Send**).

### Progress note editor

Paths: `/patients/[client id]/add-progress-note` (new) and `/patients/[client id]/edit-progress-note/[note id]`. Reached from **Write note**, **Add note**, **New**, then **Progress note**, and similar buttons.

Top bar:

- Back arrow (**Back to chart**), the client's name with date of birth and age, the session date and time, Telehealth or In person.
- Tabs: **Progress note**, **Chart note**, **Treatment progress** (for a plan: the plan's name and **Treatment progress**).
- **Saved [time]** or **Draft**, **Save as draft**, and **Sign** (for a supervised clinician the button reads **Save for supervisor**).
- **⋯** (when it applies): **Entered in error**, **Move to another chart**.

Main column:

- **Note Style** card: **Formats for** (**Therapy**, **Prescriber**, **Case management**, **Peer recovery support**, **All formats**) and the format. Therapy: **Initial Intake** (presenting problem, history, formulation, plan), **SOAP** (Subjective, Objective, Assessment, Plan), **DAP** (Data, Assessment, Plan), **BIRP** (Behavior, Intervention, Response, Plan), **GIRP** (Goals, Intervention, Response, Plan), **Comprehensive** (full clinical note with MSE), **Free-form** (simple narrative). Prescriber: **Medication Management** (E/M visit with MDM scoring), **Psychiatric Evaluation**, **Med Mgmt + Therapy**, **Free-form**. Case management: **Case Management Contact**, **Service Plan**. Peer recovery support: **Peer Support Session**. The family a clinician sees first follows their role; **All formats** shows every one.
- **DashNotes recorder** (when DashNotes is on): choose **In person**, **Telehealth** or **Dictate**, see the client's recording consent pill, then **Start recording** or **Start dictating**. After the recording, the draft is written into the note. **Not what you wanted?** offers **Length**: **Detailed** or **Concise**.
- Session details: **Date of service**, **Start time**, **Stop time**, **Duration** (presets 15 to 90 min), **Session type** (**Individual**, **Family**, **Group**), **Delivered** (**In person (office)**, **Telehealth, client at home**, **Telehealth, client elsewhere**), **Service**, **Procedure code**, **Session total**.
- **Diagnosis** (search ICD-10 or **Enter it manually**, **Add another diagnosis**).
- The note sections for the chosen format (for SOAP: **S Subjective**, **O Objective**, **A Assessment**, **P Plan**, each with **Last note** to see the previous one).
- **Objectives addressed** when the client has a signed plan.
- **Risk assessment** (**All denied** or **Needs attention**, Suicidal ideation, Homicidal ideation, Self-harm).
- **Psychotherapy notes**: private process notes, "Private to you", kept apart from the chart.

Signing: **Sign** opens **Sign and Lock Note** (or **Sign and send to your supervisor**). "Enter your full legal name to sign this note", a signature preview, **Date and time**, **IP address**. Buttons **Cancel** and **Sign and Lock Note** (or **Sign and send to supervisor**). Once signed the note is locked: "This note is signed and locked."

A supervisor reviewing a supervisee's note sees **Co-sign and lock** and **Return for edits** (with "What needs to change").

In the demo, **Start recording** shows a stand-in recorder ("DashNotes", **Start recording**, **Cancel**, then **Pause** or **Resume** and **End and draft note**, then "Writing your draft" and "Your draft is written"). The demo never asks for the microphone.

Source: template/src/pages/patients/AddProgressNote.tsx, template/src/demo/DemoChrome.tsx

### Older notes list

Path: `/patients/[client id]/progress-notes` (from **View note** on the Dashboard's Past two weeks). Filters **All**, **Drafts**, **Signed**; row buttons **View Note**, **Download PDF**, **Submit Claim**, **Edit Draft**, **Delete (audit logged)**. Use the chart instead for training videos.

Source: template/src/pages/patients/ProgressNotesList.tsx

### Letter page

Paths: `/patients/[client id]/letters/new` and `/patients/[client id]/letters/[letter id]`.

- New letter: "Letter for [client]", letter types grouped by audience (in the demo: Schools, Verification, Other providers, Clients, Courts and agencies; for example **School excuse**, **Attendance verification**, **Treatment summary**, **Discharge**, **SAP appeal support**, **Probation or parole update**), then **Or** **Write my own**. **Back to chart**.
- Writing: **Letter type**, **Addressed to**, **Date** (MM/DD/YYYY), **Subject**, **Include** (**Nothing clinical** or **Also the diagnosis**), **Body**, with a live preview. Buttons **Sign letter**, **Save draft**, **Discard**.
- Signing window **Sign this letter**: **My saved signature**, **Type** or **Draw**, then **Sign letter** or **Cancel**. "Signed. The letter is filed on the chart under Files, Letters."
- Signed letter: **Send to client** (posts to the portal with an email and text notice; later **Send again**), **Download**, **Print**, **Fax**, **Revise**, **Back to chart**. Pills **Draft**, **Signed**, **In client portal**.

Source: template/src/pages/patients/LetterPage.tsx

### Groups

Path: `/groups`. "The standing groups this practice runs." **New group** (fields **Name**, **Description**, **Usual code**, **Usual length**, buttons **Create**, **Cancel**). Each group opens with **Rename**, **Code**, **Length**, **Archive**, its members with **Remove**, and "Add a client: type a name". The group roster is the starting list for a group note; attendance is decided on each note.

Source: template/src/pages/Groups.tsx

### Appointments

Path: `/appointments`. Title **Appointments**, button **Refresh**.

Filter buttons with counts: **Needs note**, **Upcoming**, **Past**, **Cancellations**, **Reschedule requests**. Then **All clinicians** (administrators) and **Date range** (**Last 7 days**, **Last 30 days**, **This month**, **Last month**, **Last 90 days**, or From and To with **Apply**). Order: **Most recent first** or **Oldest first**.

- Session list columns: Patient, When, Clinician, Session type, Forms, Status. Row menu: **View Patient**, **Add Progress Note** (completed sessions without a note), and a delete option that asks "Are you sure you want to delete this appointment from LeadDash?"
- Cancellations and Reschedule requests columns: When, Client, Clinician, By, Reason, Practice told, Actions. "Inside 24 hours: late fee may apply" shows on late ones; **Book a new time** rebooks.

Source: template/src/pages/appointments/appointments.tsx

### Conversations

Path: `/conversations`. Title **Conversations** with a **Live** indicator.

- Left: "Search a name or message", chips **All**, **Texts**, **Emails**, **Calls**, **Unread**, **Archived**, and (administrators) **Clients only** or **Everything**. **Show more** at the bottom.
- Right: the thread with **Open chart**, **Archive** (or **Restore**). Emails show **Reply** and **Reply all**; calls can show a transcript.
- Reply box: Text or Email, **Cc (optional, comma separated)**, **Subject**, **Message**, then **Send text** or **Send email**. "Sent from your practice. Keep it to scheduling and logistics; clinical content belongs in a session."

In the demo, sending adds the message to the thread; nothing is really sent.

Source: template/src/pages/ClientConversations.tsx

### To sign

Path: `/to-sign`. Title **To sign**. Tabs **Waiting on me**, **Sent back**, **Waiting on clients**. Columns: Client, Document, Written by, Due, Waiting on, and **Open** on each row. In the demo, one treatment plan waits on Sarah Chen as supervisor and two wait on clients.

Source: template/src/pages/tosign/ToSign.tsx

### Insurance (Claims center)

Path: `/insurance`. Add `?tab=to-bill`, `claims`, `unpaid`, `payments` or `owes` to open a tab.

Top: title **Claims center**, buttons **Pull remittances**, **⋯** (**Pull older remittances**, **Claims tracking**, **Export 837P**), and **Add insurance payment** (opens the Add insurance payment page).

Tabs: **To be submitted**, **Claims**, **Unpaid claims**, **Payments**, **Client owes**.

**To be submitted**

- Folder tabs **To be submitted** and **Not submitting**, each with a count.
- Filters: **Client name**, **All clinicians**, period (**All dates**, **This month**, **Last month**, **This year**), **Show** (**All sessions**, **Ready only**, **Needs info only**), and "[n] ready, [n] need info".
- Columns: Client, Date of service, Service, Clinician, Payer, Fee, Status (**Ready**, **Needs info**, **Blocked**). Row arrow opens the checks: **Diagnosis**, **Rendering provider**, **Coverage**, **Note**, **Place of service**, **Session**, with a fix link for anything missing.
- Row buttons: **Create claim** (only when Ready) and **⋯** with **Edit session**, **Bill the client instead**, **Not submitting**.
- Tick several Ready rows, then **Create [n] claims**. Tick rows and **Not submitting [n]** to hold them.
- Not submitting asks **Why** (**Client is paying privately**, **Non-covered service**, **Timely filing passed**, **Duplicate session**, **Other**) and **Note (optional)**, then **Mark not submitting**. On the Not submitting tab, **Submit after all** puts a session back.

**Create claim** opens the claim form: "Insurance Claim for [client]", "CMS-1500 Health Insurance Claim Form" with a status (**New**, **Draft**, **Prepared**, **Submitted**). Buttons **Print**, **Download**, **Save Claim**, **Mark as Submitted**, **Submit to Clearinghouse**. In a batch it shows "Claim [n] of [n] in this batch". In the demo, **Save Claim** saves a real claim (status **Ready**) that leaves To be submitted and shows on the Claims tab, and **Submit to Clearinghouse** marks it **Submitted** and shows the "In your own account this would send the claim to your clearinghouse..." notice. Press Escape to close the notice.

**Claims** and **Unpaid claims**

- Filters: dates, **All payers**, **All statuses** (**Paid**, **Needs review**, **Submitted**, **Denied**, **Rejected**, **Not sent**), "Search client".
- Claims columns: Date of service, Client, Payer, Status, Billed, Insurance paid. Unpaid claims adds Filed and Days waiting.
- Click a row to open the claim in place: payer claim #, account #, member ID, provider, **Fix and resend** (rejected or denied), date of service with **Edit**, the payment lines, **Open in full page**, **Delete claim**.
- When the Unpaid claims tab is opened with `&pay=1` (from Claims tracking's **Add insurance payment**), a bar **Adding an insurance payment** appears: **Payer**, **Check number**, **Paid on**, and per-claim cells Check #, Payment, Write-off, Client owes, Date of payment. Bottom: counts, **Cancel**, **Save payment**.

**Payments**: insurance payments (EFT, check or entered by hand). Filters payer and status (**Allocated**, **Unallocated**, **Processed, $0 paid**, **Denied**). Columns Date, Payer, Payment method, Status, Amount; open a row for the claims on it.

**Client owes**: clients with a balance after insurance. Columns Client, Sessions, Oldest, Balance, and **Open client billing**.

Source: template/src/pages/insurance/Insurance.tsx, template/src/pages/insurance/ToBeSubmitted.tsx, template/src/pages/insurance/ClaimsCenterLists.tsx

### Claim details page

Path: `/billing/claims/[claim id]` (from **Open in full page**). **Back to claims**, **Download claim report**, the claim's identifiers, **Fix and resend**, **Payment overview** (Date, Service, Billed, Client responsibility, Insurance paid, Write-off), and **Insurance payment report (ERA)** with the payer's figures, adjustments and remarks.

Source: template/src/pages/billing/ClaimDetails.tsx

### Add insurance payment page

Path: `/insurance/payment/new` (from the Claims center button, or from a chart's **+ New**, **Add insurance payment**, which adds the client to the address). For one EOB or check that covers several sessions.

- Breadcrumb **Insurance** / **Claims center** (or the client's chart).
- Fields: **Insurance payer** (**Any payer** or one), **Payment date** (MM/DD/YYYY), **Payment method** (**Check**, **EFT**, **Virtual card**), **Check or reference #**, **Total amount**, **Client** ("All clients"), **Dates of service from**, **To**.
- Table: Date of service, Client, Service, Claim, Fee, Insurance paid, Write-off, Client owes. Type the EOB's paid amount and write-off on each line; Client owes fills itself. A small gear next to Write-off fills it so the client owes nothing.
- Footer: **Total**, **Allocated**, **Unallocated**, **Write-offs**, **Clients owe**, **Cancel**, **Save payment**. "The payment saves when Unallocated is $0.00."

In the demo this page lists no sessions. Show the fields only.

Source: template/src/pages/insurance/InsurancePaymentNew.tsx

### Claims tracking

Path: `/insurance/tracking` (Claims center **⋯**). "Monitor claim status and post payments." Figures **Awaiting response**, **Needs attention**, **Outstanding**, **Collected**; filters for status, dates and search; row actions **Mark accepted**, **Mark rejected**, **Post payment**, **Fix and resubmit**, **View details**. Its **Post payment** points to the Claims center.

Source: template/src/pages/insurance/ClaimsTrackingPage.tsx

### Billing overview

Path: `/billing`. Title **Billing overview**. Period (**This month**, **Last month**, **This quarter**, **Last quarter**, **Year to date**, **Last year**, **Custom dates**) and **Invoice sessions** (goes to Invoices).

Figures (each opens a list): **Received**, **Deposited**, **Refunded**, **Clients owe**, **Awaiting insurance**, **Unapplied**, **Unclaimed** (goes to Insurance).

List tabs: **Payments** (Date, From, Source, Type, Amount; **Refund**, **View**, **Attach** for remittances with no client), **Card transactions** (Stripe charges, fees, deposits), **Payouts** (deposits to the bank, **Hide payments**), **Unapplied** (**Apply**, **Refund**), **Invoices** (**View invoice**).

Source: template/src/pages/billing/BillingOverview.tsx

### Invoices

Path: `/billing/invoicing`. Title **Invoices**, a pill **Created manually** or **Created automatically · Daily**, **Change** (goes to settings), period, search "Client or invoice number", **Refresh**.

- **Invoices** tab: chips **Unpaid**, **Paid**, **Void**, **All**, and Balance. Columns Invoice, Client, Date, For, Amount, Paid, Balance, Status, **Open**.
- **Not yet invoiced** tab (when there are any): sessions the client owes on, grouped by client and period, and **Create invoices**.

Invoice page (`/patients/[client id]/invoices/[invoice id]`): **Edit**, **Record payment**, **Charge card on file**, **Send to client**, **Download PDF**, **More** (**Print or download PDF**, **Void invoice**). Shows Charges, Insurance paid, Adjustments, Client paid, With insurance, Balance due, the lines, and **Activity**. Record a payment asks **Amount**, **Date received**, method (**Cash**, **Check**, **Card, taken elsewhere**, **Other**), **Check number**. Void asks a **Reason**.

New invoice (`/patients/[client id]/invoices/new`): **New invoice**, From, Bill to, Issued, Due, Client, Provider, lines (Date, Description, Amount, **Remove**, **+ Add line item**), side lists **Sessions not yet invoiced** and **Services and fees**, totals, **Notes**, and **Cancel**, **Save invoice**.

Source: template/src/pages/billing/Invoicing.tsx, template/src/pages/invoices/invoiceDetails.tsx, template/src/pages/invoices/InvoiceDocumentEditor.tsx

### Fax

Path: `/fax`. Title **Fax**. Figures **Waiting to file**, **Pages left to send**, **Received this month**. Tabs **Waiting to file**, **Received**, **Sent**. A received fax has **Open** and a filing window **File this fax on a chart** (**Client**, "Type a name", **Cancel**, **File it**).

Sending a fax starts from a chart (Files tab **Fax**, a file's **Fax**, or a signed letter's **Fax**). The **Send a fax** window has **Document** (a PDF from the chart), **Fax number**, **Confirm fax number**, **Recipient**, **Regarding**, **Message**, and **Cancel**, **Send fax**.

Source: template/src/pages/fax/FaxInbox.tsx, template/src/components/FaxSend.tsx

### Reports

Path: `/reports` and the six sub-paths. Title **Reports**, period (**This month**, **Last month**, **This quarter**, **Year to date**, **Last year**), From and To dates, **Refresh**. Tabs: **Overview**, **Income**, **Outstanding**, **Claims**, **Sessions**, **Provider collections**, **Caseload**.

- Overview: collections over the last seven months, Not collected, Clients owe, Sitting with a payer, Claims filed, Who collected it.
- Income: **Received**, **From clients**, **From insurance**, **No source recorded**, **Not yet applied**, and the list.
- Outstanding: aging buckets **0 to 30 days**, **31 to 60**, **61 to 90**, **Over 90**, and the list (Age, Client, Date of service, Service, Owed by, Balance).
- Claims: **All**, **Needs work**, **Still out**, **Paid**; Filed, Paid, Denied, Still out.
- Sessions: **Clinician** or **Whole practice**, sessions in the period, and the list (Date, Client, Clinician, What happened, Billing, Fee).
- Provider collections: "Collections by rendering provider, for payroll", **Reporting period**, **Count claims by** (**Payment date** or **Date of service**), a table per provider (Claims, Billed, Insurance, Client payments, Total collected, Split, Payout, Write-offs, Patient owes, Avg days to pay), and **Hide payroll**.
- Caseload: **Clinician**, status, **As of**, **Download CSV**, list with Client, Date of birth, First seen, Status, Billing, and bulk **Mark active**, **Mark inactive**, **Exclude from EHR**.

Source: template/src/pages/reports/Reports.tsx, template/src/pages/insurance/ProviderCollections.tsx

### Payer Enrollment

Path: `/admin/claimmd/enrollment`. Each payer shows its status: **Ready**, **Needs enrollment**, **Pending**, or **Not offered by this payer**. Actions **Open enrollment**, **Update status** (**Approved**, **Rejected**, **Sent again**), **Enroll again**, **Remove this payer**. In the demo, sending an enrollment shows a notice.

Source: template/src/components/admin/PayerEnrollment.tsx

### Setup checklist

Path: `/setup`. Milestones with progress, **Do it now →** links, **Review**, and **undo** on items a person ticked. Green rows were checked by the system.

Source: template/src/pages/SetupChecklist.tsx

### Audit Trail

Path: `/audit-logs`. Title **Audit Trail**. Search "Search logs...", **All Actions** (View, Create, Update, Delete, Sign, Login, Logout, Download, Upload, Submit), **All Resources** (Patient, Progress Note, File, Claim, Appointment, Authentication, Payment, Invoice, Settings), **Start date**, **End date**, **Clear filters**. Columns Timestamp, Action, Resource, Description, User, Patient.

Source: template/src/pages/AuditLogs.tsx

### My account

Path: `/account` (the **My account** link under your name). Sections: **Profile** (photo **Change photo**, **Name on notes**, **Mobile**, **Your signature** with **Draw a new one** and **Save signature**), **Sign-in** (**Sign-in devices**, sessions), **Notifications** (what the practice sends you), **Hours and time off**, **Outside calendars**.

Hours and time off: **Weekly hours** (**Edit**, **+ Add hours**, **Remove these hours**, **Cancel**, **Save**), **Services they offer** (**Edit**), **Time off** (**+ Add**, From, to, **Cancel**, **Save**; **Remove** on each). "Staff can still book you outside these hours; the calendar warns them first."

Source: template/src/pages/account/MyAccount.tsx, template/src/components/settings/ClinicianAvailability.tsx

### Settings: Practice info

Cards, each with **Edit**, then **Cancel** and **Save**:

- **Practice**: **Practice name**, **Contact**, **Address**, **Suite (optional)**, **City**, **State**, **ZIP**, **Phone**, **Fax (optional)**, **Email**, **Timezone**, **Office hours**, **Logo** (PNG, JPG, WebP or SVG, under 2 MB). The logo shows only on client-facing pages: sign-in screen, portal, statements, booking page.
- **Billing identifiers** (Complete or Incomplete): **Billing NPI (organization)**, **Tax ID** (EIN or SSN), **Taxonomy code**, billing address.
- **Email to clients**: **Replies go to**, **Send a test**.
- **On your client forms**: legal entity name, where clients write to you, privacy notice date, states licensed in, ages, records fee, crisis line, evaluation fees.
- **Copays**: **Collect copays through the client portal before sessions**.

Source: template/src/components/PracticeSettings.tsx

### Settings: Locations

The practice's places. Each shows what goes on the claim, with **Edit** and **Remove**. **New location** fields: **Name clients see**, **Place of service on the claim** (two digits), **Address line 1**, **Address line 2**, **City**, **State**, **ZIP**, **What to tell clients when they arrive**, **Phone clients should call**, **Use this one by default on new services**.

**Closures**: **Add closure**. Fields **From**, **To**, **Reason**, **Every location** or **Only some**. The list shows Dates, Reason, Applies to, Online booking (**Blocked**), with **Edit** and **Remove**. "Staff can still book on a closed day from the calendar; the same warning as booking outside availability appears, with Book anyway."

Source: template/src/components/Locations.tsx

### Settings: Team

Tabs **People**, **Roles**, **Hours**, **Former**.

- People: chips **Everyone**, **No NPI**, **License expiring**, **Changed from role**; search; columns Person, Role, Can see, Credentials, Hours, and **Open**. A person opens with sections, each with **Edit**: **Access** (role, can see, sees clients), **Supervision** (**Their notes need a co-signature**, **Reviewed first by**, **Co-signing supervisors**, **Supervising provider for claims**), **Credentials** (**NPI**, **Taxonomy**, **License type**, **License number**, **State**, **License expires**, **Signs notes as**), **Supervises**, **Sign-in** (**Email**, **Mobile phone**), **Hours**, and **Change photo**.
- Roles: **Add a role**, each role with **Copy** and **Edit**.
- Hours: each clinician's weekly hours with **Edit**.
- Former: people who left.

The Team page has no button to create a new person. New sign-ins come from the LeadDash platform account.

Source: template/src/components/TeamPermissions.tsx

### Settings: Client forms

Folder tabs **Forms**, **Packets**, and when present **Optional sections** and **Assessments**. Buttons **New form** and **New packet**. Forms list: Form, Length, Sent automatically, Status, with **Edit**, **Preview**, **Make a copy**. Packets: name, forms in order, **Edit**, **Remove packet**, **Save changes**. Editing a built-in form "makes it yours".

Source: template/src/components/ClientForms.tsx

### Settings: Services

**Add a service**. List: Service, Rate, Duration, Online booking (**Staff only**, **Call to book**, **Client portal only**, **Billing only**), Offered by, **Edit**. A service has: **Service** code, rate per unit, **Description** (what clients pick), **On statements and invoices**, **Default duration**, **Bill in units**, **Self-pay, never billed to insurance**, **Online booking** (**Clients can request it online**, **Clients call first to request a time**, card rules), where clients may book, **Show the price**, **Show a description**, **Booking window**, **Start times** (**on the hour**, **every 30 minutes**, **every 15 minutes**), **Block off** minutes before and after, **Offered by**, **Where**, **Delete service**, **Cancel**, **Save**.

Source: template/src/components/settings/ServicesSettings.tsx

### Settings: Note templates and Letter templates

Note templates: the formats clinicians write in, built from sections and questions. Letter templates: search "Search letters", **New template**, list with Letter, Asks for, and **Make a copy**, **Edit**, **Remove**. A template has **Name**, **Group**, **Addressed to**, **Subject**, **Body** with merge fields, and facts the editor asks for (**Add a fact**).

Source: template/src/components/NoteTemplates.tsx, template/src/components/LetterTemplates.tsx

### Settings: Portal and booking page

Tabs **Client portal** and **Booking page**.

- Client portal card: address (portal.leaddash.io/ and the practice's address), **Phone shown to clients**, **Invoices and payment links from**, **New clients see** (**Request an appointment, and call**, **Request an appointment**, **Call to book**), **Edit**, **Open**. **What clients see** switches. **Links every client can open**: **Add link**. **Live preview** of the real portal with a sample client, with screen buttons **Sign in**, **Sessions**, **Documents**, **Billing**, **Account**.
- Booking page card: **Live**, **Edit**, **Open**, offices and services, phone, **Put it on your own website** with the **Embed code**, and a **Live preview** with steps **Start**, **Where**, **Who**, **What**, **Time**. "Nothing can be booked from here."

Source: template/src/components/ClientPortalSettings.tsx

### Settings: Telehealth, Client messages, HIPAA-compliant phone, Payments and invoices, Insurance, Fax

- **Telehealth**: one video room per clinician. **New room** (Whose room, Room name, Address), each room with **Open now**, **Copy the address**, and a waiting room message.
- **Client messages**: reminders and notices with **Send by** (Text message, Email), **Quiet hours**, **When to send**, **What to say** with previews; **Follow up after a missed session**; **Morning summary** for staff; **Appointments and money** notices (Email, Text, Push); **When a client submits a form**. Staff notices name clients by initials only.
- **HIPAA-compliant phone**: the practice's number for texts and calls and its carrier registration.
- **Payments and invoices**: **Card payments** (Stripe **Connected** or **Not connected**, **Manage in Stripe**, **Disconnect**) and **Invoices** (**Manual** or **Automatic, daily**, **Since**, **AutoPay**, **Edit**).
- **Insurance**: **Claims** (Filed as, Group NPI, Tax ID, Taxonomy, Rendering provider), **Supervised claims** (modifiers by payer, **Add a payer**), **Eligibility checks** (Included, Used), and the payer list.
- **Fax**: reserve a number by area code (**Reserve number**), Fax number, Pages sent, Received, Waiting to file.

Source: template/src/components/TelehealthSettings.tsx, template/src/components/ReminderSettings.tsx, template/src/components/PhoneSetup.tsx, template/src/components/settings/StripeConnectSettings.tsx, template/src/components/settings/InvoiceSettings.tsx, template/src/components/settings/InsuranceSettings.tsx, template/src/components/FaxSettingsPanel.tsx

### Client portal (what clients see)

Real address: portal.leaddash.io followed by the practice's portal address. In the demo, show it only through **Practice Settings**, **Portal and booking page**, **Live preview**, which shows the real portal with a sample client named Jordan Lee.

- Sign in: "Sign in to your portal", **Sign in with this device**, **Email or phone number**, **Continue**, then a six-digit code (**Sign in**), then **Confirm your date of birth** (MM/DD/YYYY), then **Save this device** or **Not now**. New clients see **Request an appointment**.
- Bottom tabs: **Sessions**, **Documents**, **Billing**, **Messages**, **Account** (Messages shows only when the practice turns it on).
- Sessions: upcoming sessions with **Confirm**, **Reschedule**, **Cancel** (Reschedule and Cancel ask "Why? The practice sees this." then **Keep it** or **Request reschedule** / **Cancel appointment**), **Join session** for video, and **Book a session**.
- Documents: **Paperwork** to fill and sign, signed documents, plans to sign (**Sign plan**), links from the practice.
- Billing: invoices, balance, **Pay now**, cards.
- Account: **Your practice**, **Text messages**, **Sign-in** (**Save this device**), **Forms and documents**, **Sign out**.

Source: portal/index.html

### Booking page (what new clients see)

Real address: portal.leaddash.io/book/ followed by the practice's booking address. In the demo, show it only through the **Booking page** tab's **Live preview**. Steps **Start**, **Where**, **Who**, **What**, **Time**.

Source: booking.html, template/src/components/ClientPortalSettings.tsx

### Mobile App

Path: `/mobile-app`. Install steps for **On your iPhone or iPad**, **On your Android phone or tablet**, **On your Mac**, an **Install LeadDash** button when the browser can install, and **Good to know**.

Source: template/src/pages/mobile-app/MobileApp.tsx

## Tasks

Every task starts in the demo at https://demo.leaddash.io, signed in as Sarah Chen. Record each task in one take without reloading. Open charts from **Patients**, not from the header search.

**Front desk tasks**

### Book a session for an existing client

- For: Front desk
- Starts on: Calendar (`/calendar-view`), Week view.
- Needs in the demo: any active client, such as Adrienne Fowler.
- Steps:
  1. Click **Add appointment** at the top right. The **Add appointment** window opens.
  2. Under **Who**, type "Adrienne". Click **Adrienne Fowler** in the list. Her date of birth, age and insurance benefits appear.
  3. Under **What**, pick **Sarah Chen** in **Clinician**.
  4. Click **Telehealth** under **Where**.
  5. Pick **Individual Therapy For Adults** in **Service**. Calendar, Code, Fee and Place of service fill in.
  6. Under **When**, click a day with a dot, then click one of the time buttons.
  7. Leave **Send the client a confirmation by email and text** ticked (the demo sends nothing).
  8. Click **Create appointment**.
- Done when: the window closes and the session shows on the calendar on that day and time.
- Watch out: the same window opens from the header button on any page and from a chart's **Schedule**. In the demo the booking lasts until the page reloads.

### Book a session from an open time on the calendar

- For: Front desk
- Starts on: Calendar, Week view, with one clinician picked under **Clinicians:**.
- Needs in the demo: nothing extra.
- Steps:
  1. Click **Clinicians:**, tick **Sarah Chen**, click **Done**. Her availability shading appears.
  2. Click an empty time on the grid. The "Add to the calendar" window opens on the **Appointment** tab, with the day and time named.
  3. Click **Continue**. **Add appointment** opens with that day and time filled in.
  4. Pick the client, clinician, place and service as in the task above.
  5. Click **Create appointment**.
- Done when: the new session sits in the slot you clicked.
- Watch out: clicking an existing session opens that session, not a new booking.

### Book outside a clinician's availability

- For: Front desk
- Starts on: Add appointment window, client, clinician, place and service already picked.
- Needs in the demo: nothing extra.
- Steps:
  1. Under **When**, type an early time such as 7:00 AM in **Start**, or pick a grey day.
  2. An amber warning appears explaining the time is outside the clinician's availability, ending "Book anyway, or pick another time."
  3. The main button now reads **Book anyway**. Click it.
- Done when: the session shows on the calendar at that time.
- Watch out: the app never blocks a booking; it only warns. An overlap with another session shows a similar warning.

### Book a weekly series

- For: Front desk
- Starts on: Add appointment window, client, clinician, place, service, day and time picked.
- Needs in the demo: any individual client (not a couples chart).
- Steps:
  1. Tick **Repeat**.
  2. Choose **Every week** and **12 sessions**.
  3. Read the line "Booked as one series... The client gets one confirmation for the series".
  4. Click **Create 12 appointments**.
- Done when: the sessions appear on the same weekday for the following weeks.
- Watch out: if some dates collide with other bookings, a warning lists them and the button reads **Book 12 anyway**.

### Reschedule by dragging a session

- For: Front desk
- Starts on: Calendar, Week view, a future session visible.
- Needs in the demo: any future session.
- Steps:
  1. Press and hold on a session, drag it to a new time, and let go.
  2. The window "Move [client] to [new time]?" opens, showing the old time.
  3. Leave **Let [first name] know** ticked or untick it.
  4. Click **Move** (or **Move anyway** if a warning shows).
- Done when: the session sits at the new time.
- Watch out: **Put it back** cancels the move. You can also reschedule, or change the client, clinician or service, with **Edit appointment** on the session card: change the details, tick **Let [first name] know about the change** if the client should hear, and click **Save changes**. The notice goes only when the time, clinician or service changes.

### Cancel a session or mark a no-show

- For: Front desk
- Starts on: Calendar, a session card open.
- Needs in the demo: any session.
- Steps:
  1. Click the status button at the top of the card. **Update status** opens.
  2. Click **Cancelled** (or **Late Cancellation**, **No Show**, **Clinician Cancellation**, **Reschedule requested**).
- Done when: the status button shows the new status and the session's color changes.
- Watch out: cancelling keeps the session on record. **Delete appointment** removes it, and if it has billing, its charge and invoice go with it. Use delete only for a session booked by mistake. Cancellations and client reschedule requests also list on **Appointments**, under **Cancellations** and **Reschedule requests**.

### Check in a client (mark showed)

- For: Front desk
- Starts on: Calendar, Day view on today.
- Needs in the demo: a session today.
- Steps:
  1. Click today's session. Its card opens.
  2. Click the status button and choose **Showed**.
- Done when: the status reads **Showed**.
- Watch out: there is no separate Check in button. In a live practice, sessions still marked Confirmed after they end are marked Showed by the system every few minutes unless the practice turned that off, and a Showed session becomes a charge. Mark No Show or a cancellation before that if the client did not come.

### Send a reminder or the video link now

- For: Front desk
- Starts on: Calendar, a session today open.
- Needs in the demo: a session today; a telehealth one for the link.
- Steps:
  1. Click **Remind now**. A message box opens with the text filled in.
  2. Keep or change the text. Leave the text and email ticks as they are.
  3. Click **Send reminder**.
  4. For a video session, click **Send link** instead to text and email the join link.
- Done when: the card shows "Reminder sent by text and email. It is on the chart's Communication tab." (or "Link sent by...").
- Watch out: in the demo nothing reaches anyone. In a live practice this messages a real client; check the client before sending.

### Add a new client

- For: Front desk
- Starts on: Patients (`/patients`).
- Needs in the demo: nothing.
- Steps:
  1. Click **Add client**. **Add a client** opens.
  2. Type a made-up **First name** and **Last name**.
  3. Type an example email such as test@example.com, or a 555 phone number.
  4. Type a **Date of birth**.
  5. Pick a **Clinician**.
  6. Click **Add client**.
- Done when: the new client's chart opens with their name at the top.
- Watch out: never type a real person's details, even in the demo. An email or a phone is required.

### Send intake paperwork

- For: Front desk
- Starts on: a client's chart, **Files** tab.
- Needs in the demo: a client with a phone or email (all demo clients have both).
- Steps:
  1. Click **Send form**. The panel opens on **Forms to sign**.
  2. Tick a packet or forms, for example "New client intake" and "Consent for treatment".
  3. Under **Send by**, click **Both**.
  4. Click **Send 2** (the number matches what you ticked).
- Done when: the panel closes and the forms list shows them as sent and waiting.
- Watch out: the Clinical tab's Paperwork card has **Send form** too; it opens this same panel. The first paperwork for a client also sends a welcome email with sign-in. To chase unfinished paperwork, use the remind button on a **Waiting** form in the Clinical tab's Paperwork card, or **Remind again** on a packet in the Overview list.

### Reply to a client message

- For: Front desk
- Starts on: Conversations (`/conversations`).
- Needs in the demo: the sample threads.
- Steps:
  1. Click **Unread** to see new messages.
  2. Click a thread.
  3. Type a short scheduling reply in **Message**.
  4. Click **Send text** (or **Send email**).
- Done when: your reply shows at the bottom of the thread.
- Watch out: keep messages to scheduling and logistics. **Archive** takes a thread out of the inbox until the client writes again.

**Clinician tasks**

### Write and sign a progress note

- For: Clinicians
- Starts on: Dashboard, **To do** card, **Notes** tab.
- Needs in the demo: a session marked Needs note (the six most recent past sessions).
- Steps:
  1. Click **Write note** on a row. The note editor opens on **Progress note** with the session date and time filled in.
  2. Show the top bar: the client's name with date of birth and age, the session date and time, the tabs **Progress note**, **Chart note** and **Treatment progress**, and **Save as draft** and **Sign**. Say what each tab is for: Progress note is the session note, Chart note is a short note on the chart outside a session, Treatment progress records work against the plan.
  3. Show the **Note Style** card. Name every **Formats for** group and what it is for: **Therapy** (counseling sessions), **Prescriber** (medication visits), **Case management**, **Peer recovery support**, and **All formats**.
  4. Name every format under Therapy and when a clinician uses it: **SOAP** (Subjective, Objective, Assessment, Plan: the most common), **DAP** (Data, Assessment, Plan: shorter), **BIRP** (Behavior, Intervention, Response, Plan: ties the note to what the clinician did), **GIRP** (Goal, Intervention, Response, Plan: ties it to the treatment plan goal), **Initial Intake** (the first session), **Comprehensive** (a full assessment), **Free-form** (one open box). Say the sections below change with the format and that every format signs the same way. Then choose **SOAP** for the example.
  5. Show the **DashNotes recorder** card and say it can write the draft from a recording or dictation; this video types the note instead.
  6. Scroll to the session details. Check **Date of service**, **Start time**, **Stop time**, **Duration**, **Session type**, **Delivered**, **Service** and **Procedure code**, naming each.
  7. Show **Diagnosis**: the diagnosis on the chart is already there; **Add another diagnosis** adds one.
  8. Fill in **S Subjective**, **O Objective**, **A Assessment**, **P Plan** with made-up text, scrolling so each section is on screen as it is filled. Mention **Last note** on each section shows the previous note's words.
  9. Scroll to **Risk assessment** and set it to **All denied** if that fits the made-up session; say **Needs attention** opens the three risk questions.
  10. Show **Psychotherapy notes** and say they are private to the clinician and never part of the record.
  11. Scroll to the top and click **Sign**. **Sign and Lock Note** opens.
  12. Type the name in "Enter your full legal name to sign this note". A signature preview appears.
  13. Click **Sign and Lock Note**.
- Done when: the note reads "This note is signed and locked." and the session shows **Signed** on the chart.
- Length: this is a 4 to 5 minute video. If the ask is only how to sign a note, or only the formats, make that part alone.
- Watch out: **Save as draft** keeps it unsigned. A signed note cannot be edited; a wrong note is fixed with **⋯**, **Entered in error**. Never type real client information.

### Draft a note with DashNotes

- For: Clinicians
- Starts on: the progress note editor for a session.
- Needs in the demo: any session needing a note.
- Steps:
  1. In the DashNotes recorder card, click **In person**.
  2. Click **Start recording**. In the demo a stand-in recorder appears.
  3. Click **Start recording** in it. It shows **Recording**.
  4. Click **End and draft note**. It shows "Writing your draft", then "Your draft is written".
  5. Read the draft in the note sections. Under **Not what you wanted?**, try **Concise** or **Detailed**.
  6. Sign as in the task above.
- Done when: the note sections hold the drafted text.
- Watch out: the demo never asks for the microphone. In a live practice, check the client's recording consent pill first.

### Review and co-sign a supervisee's note

- For: Clinicians (supervisors)
- Starts on: Dashboard, **To do**, **Co-signature** tab, or **To sign**.
- Needs in the demo: a note by Alicia Grant waiting on Sarah. The demo has treatment plans waiting on Sarah on **To sign**; check whether a note is waiting before planning this video.
- Steps:
  1. Click **Review and sign** on the row.
  2. Read the note.
  3. Click **Co-sign and lock**, type your name, and confirm.
  4. Or click **Return for edits**, type what needs to change, and confirm.
- Done when: the note shows co-signed and locked, or returned.
- Watch out: a supervised clinician's own **Sign** button reads **Save for supervisor**; their note is not final until co-signed.

### Add a quick chart note

- For: Clinicians
- Starts on: a client's chart, **Overview** tab.
- Needs in the demo: any client.
- Steps:
  1. In **Quick chart note**, type a short made-up note about a phone call.
  2. Check **Date** and **Time**.
  3. Click **Add note**.
- Done when: the note appears in the visit list for that date.
- Watch out: a chart note is not a session and is not billed.

### Add or change a diagnosis

- For: Clinicians
- Starts on: a client's chart, **Clinical** tab.
- Needs in the demo: any client.
- Steps:
  1. In **Diagnoses**, click **Add**.
  2. Type a **Code** and **Description** (use a generic example).
  3. Tick **Make this the primary diagnosis** if it should be.
  4. Click **Add**.
  5. To change one, click **Edit** on it, then **Make primary**, **No longer applies** or **Entered by mistake**.
- Done when: the diagnosis shows in the list with who added it and when.
- Watch out: **History** shows earlier diagnoses. Diagnoses can also be added in the note editor.

### Start a treatment plan

- For: Clinicians
- Starts on: a client's chart, **Clinical** tab, **Plans** card.
- Needs in the demo: a client with no plan. Note the demo's library suggestions are empty and a new plan is not kept, so use **Write my own** and finish the video before reloading.
- Steps:
  1. Click **+ New plan**, then **Treatment plan**. The plan editor opens.
  2. Choose **Write my own** (or **LeadDash builder** in a live practice).
  3. Step 1 **Diagnosis**: confirm the chart's diagnosis.
  4. Step 2 **Presenting problem**: type the problem.
  5. Step 3 **Goals and objectives**: type a goal and an objective; click **Fill target dates, two weeks apart**.
  6. Click **Next: interventions** and type an intervention.
  7. Click **Next: schedule and sign**. Set **Frequency** and **Review in**.
  8. Click **Sign plan**, type your full name, and confirm.
- Done when: the plan shows as signed, or as awaiting signatures when a client or supervisor still has to sign.
- Watch out: **Save draft** keeps it unsigned and it shows on the Dashboard as **Finish and sign**. A plan can also be started from the Overview **New** menu. **One box** writes the whole plan in one text. To review a signed plan later, click **Start review** on the Plans card (or on the Dashboard's Treatment plans tab), change it, and **Sign plan**; the earlier version stays under **Earlier versions**.

### Send and read a measure (PHQ-9, GAD-7)

- For: Clinicians
- Starts on: a client's chart, **Clinical** tab, **Measures over time**.
- Needs in the demo: any client.
- Steps:
  1. Click **Send a measure**. The Files tab opens with the send panel.
  2. Tick **PHQ-9** or **GAD-7**, choose **Send by**, and click **Send 1**.
  3. Back on **Clinical**, click a measure tile to see results over time.
  4. Click a point to open that result; use **Previous result**, **Next result**, **Close**.
- Done when: the result panel shows the scores and bands.
- Watch out: measures are scored automatically. Completed ones also appear on the Overview by date.

### Write and send a letter

- For: Clinicians
- Starts on: a client's chart, **Overview**, **New** menu.
- Needs in the demo: any client.
- Steps:
  1. Click **New**, then **Letter**. The letter types appear.
  2. Click **Attendance verification**.
  3. Fill **Addressed to**, **Date** and **Subject**; leave **Include** on **Nothing clinical**.
  4. Edit the **Body**.
  5. Click **Sign letter**. In **Sign this letter**, choose **Type**, type your name, click **Sign letter**.
  6. Click **Send to client**.
- Done when: the letter shows **Signed** and **In client portal**.
- Watch out: letters are filed on the Files tab under **Letters**. **Revise** makes a new version. Never include a diagnosis unless the clinician means to.

### Start a telehealth session

- For: Clinicians
- Starts on: Calendar, a telehealth session card open.
- Needs in the demo: a telehealth session for Sarah Chen or Marcus Ortega.
- Steps:
  1. Click **Start video session**.
  2. In the demo, a notice explains what happens in a real account (the session opens in its own window and the client is let in from the waiting room).
  3. Close the notice.
- Done when: the notice shows.
- Watch out: **Copy client link** copies the client's join link. Priya Bell's sessions show **Open Google Meet** instead, which opens a real outside site; do not click it in the demo. Do not click **Join session** or **Open room** on the Dashboard in the demo either. The **My room** button in the header opens a clinician's own room at any time.

**Biller tasks**

### Submit claims from the To be submitted queue

- For: Billers
- Starts on: Insurance (`/insurance`), **To be submitted** tab.
- Needs in the demo: sessions from the last two days (always there).
- Steps:
  1. Set **Show** to **Ready only**.
  2. Click a row's arrow to see the checks (Diagnosis, Rendering provider, Coverage, Note, Place of service, Session).
  3. Click **Create claim**. The CMS-1500 claim form opens.
  4. Review the form.
  5. Click **Submit to Clearinghouse**. The claim is saved and marked **Submitted**, and a notice explains it would go to the clearinghouse. Press Escape to close the notice.
- Done when: the notice shows, and the claim leaves the queue in a live practice.
- Watch out: tick several Ready rows and click **Create [n] claims** to work a batch ("Claim 1 of 3 in this batch"). **Mark as Submitted** only records a claim sent some other way. Rows marked **Needs info** or **Blocked** cannot be claimed until fixed.

### Hold a session back from insurance

- For: Billers
- Starts on: Insurance, **To be submitted** tab.
- Needs in the demo: any row in the queue.
- Steps:
  1. Click the row's **⋯**, then **Not submitting**.
  2. Pick **Why**, for example **Client is paying privately**.
  3. Optionally type a **Note**.
  4. Click **Mark not submitting**.
- Done when: the row moves to the **Not submitting** folder tab.
- Watch out: **Bill the client instead** sends the session to the client. **Submit after all** on the Not submitting tab brings a row back.

### Work the Claims center: a rejected or denied claim

- For: Billers
- Starts on: Insurance, **Claims** tab.
- Needs in the demo: the sample Rejected and Denied claims.
- Steps:
  1. Pick **Rejected** in **All statuses**.
  2. Click the row. The claim opens under it, with the payer's message.
  3. Read the reason.
  4. Click **Fix and resend** to correct the claim form.
  5. Click **Open in full page** to see **Claim details**.
- Done when: the claim form or Claim details page is on screen.
- Watch out: Rejected means it never reached the payer; Denied means the payer refused it. Do not use **Delete claim** in a video.

### Add an insurance payment on a chart's session row

- For: Billers
- Starts on: a client's chart (an insured client such as Adrienne Fowler), **Billing** tab, **Activity**.
- Needs in the demo: a session still with insurance.
- Steps:
  1. Find a session whose Insurance column shows it is still waiting.
  2. Click its **⋯**, then **Add insurance payment**.
  3. In the row, type the EOB's paid amount under **Insurance paid** and the contractual adjustment under **Write-off**. The Client column shows what the client owes.
  4. Under the row, type **Paid on** (MM/DD/YYYY) and **Check #**.
  5. Click **Save insurance payment**.
- Done when: the line "Insurance payment saved. [Payer] paid $[amount] on [date]" appears.
- Watch out: in the demo the row's numbers do not change after saving. **Undo insurance payment** reverses a wrong posting. When the payer left part unexplained, use **Decide client share**.

### Add one insurance payment that covers several sessions

- For: Billers
- Starts on: Insurance, **Add insurance payment** button.
- Needs in the demo: none, but the demo lists no sessions on this page, so record the layout only.
- Steps:
  1. Click **Add insurance payment**. The page **Add insurance payment** opens.
  2. Pick the **Insurance payer**.
  3. Type **Payment date**, choose **Payment method**, type **Check or reference #** and the EOB's **Total amount**.
  4. Narrow with **Client** and **Dates of service from** and **To**.
  5. On each session the EOB covers, type **Insurance paid** and **Write-off**.
  6. Watch **Unallocated** reach $0.00.
  7. Click **Save payment**.
- Done when: a confirmation shows and **Back to the Claims center** appears.
- Watch out: the payment will not save until Unallocated is $0.00. The gear next to Write-off fills it so the client owes nothing.

### Take a client payment

- For: Billers, Front desk
- Starts on: a client's chart, **Billing** tab.
- Needs in the demo: a client who owes (Client owes above $0).
- Steps:
  1. Click **+ New**, then **Record payment**. **Add payment** opens.
  2. Type the **Amount**.
  3. Leave it on **Oldest unpaid invoices**.
  4. Under **How they are paying**, click **Cash**.
  5. Optionally type a **Note for the ledger**.
  6. Click **Record payment**.
- Done when: **Client owes** drops by the amount.
- Watch out: card choices (**Card on file**, **Another card**) charge a card; in the demo a notice shows instead. A payment can also be taken on a session row (**⋯**, **Add payment**) or with **Take payment** on a calendar card.

### Apply credit on file

- For: Billers
- Starts on: a client's chart, Billing tab, with **Credit on file** above $0.
- Needs in the demo: one of the clients with $40 of unapplied credit.
- Steps:
  1. Read the line "$40.00 in payments is not on a session."
  2. Click **Apply to oldest**. A plan shows which sessions the credit will pay.
  3. Click **Apply**.
- Done when: Credit on file goes down and the session's Client column is paid.
- Watch out: Billing overview's **Unapplied** list shows unapplied payments for the whole practice.

### Create and send an invoice

- For: Billers
- Starts on: a client's chart, **Billing** tab.
- Needs in the demo: a client with a session not yet invoiced.
- Steps:
  1. Click **+ New**, then **Invoice**. **New invoice** opens.
  2. Under **Sessions not yet invoiced**, add the sessions.
  3. Check the lines and **Due** date.
  4. Click **Save invoice**. The invoice page opens.
  5. Click **Send to client**. In the demo a notice explains it would email the client.
- Done when: the invoice page shows the invoice and its activity.
- Watch out: Invoices (`/billing/invoicing`), **Not yet invoiced**, **Create invoices** makes invoices for every client at once. **Void invoice** returns its sessions to Not yet invoiced.

### Generate a statement and a superbill

- For: Billers
- Starts on: a client's chart, **Billing** tab.
- Needs in the demo: any client with billing history.
- Steps:
  1. Click **+ New**, then **Statement**. **Generate a statement** opens.
  2. Set **From** and **To**.
  3. Click **Generate statement**. The statement opens to print or save as PDF.
  4. For a superbill, click **Generate superbill** in the same window.
- Done when: the statement or superbill is on screen.
- Watch out: **Email to client** sends it; skip it on camera unless the video is about sending. Made documents list under **Statements and superbills**.

### Write off a balance

- For: Billers
- Starts on: a client's chart, Billing tab, Activity.
- Needs in the demo: a session where the client owes.
- Steps:
  1. Click the session's **⋯**, then **Write off**.
  2. Type the amount and **Why** (for example "small balance").
  3. Click **Write off $[amount]**.
- Done when: the Write-off column shows the amount and Client owes drops.
- Watch out: insurance contractual adjustments go in the Write-off field when adding an insurance payment, not here.

### Check a client's eligibility

- For: Billers, Front desk
- Starts on: a client's chart, **Coverage** tab.
- Needs in the demo: an insured client.
- Steps:
  1. Find the **Insurance benefits** card.
  2. Read Active or Not active, what the client pays, deductible, and benefits.
  3. Click **Check again**.
- Done when: the card shows the latest answer and its date.
- Watch out: in the demo the earlier result stays; no payer is asked. The same check appears in the Add appointment window. Practices have a monthly number of included checks.

### Enter or fix a client's insurance

- For: Billers, Front desk
- Starts on: a client's chart, **Coverage** tab.
- Needs in the demo: any insured client.
- Steps:
  1. On **Insurance coverage**, click **Edit**.
  2. Search the **Insurance carrier**, then fill **Member ID**, **Group number**, **Policy holder name**, **Relationship to policy holder**, and copay.
  3. Click **Save**.
- Done when: the card shows **Ready to file** or what is still needed.
- Watch out: the **Billing** card on the left decides whether new sessions go to insurance or the client, from a **Since** date.

### Read the Billing overview

- For: Billers, Admins
- Starts on: Billing, Overview (`/billing`).
- Needs in the demo: the sample payments.
- Steps:
  1. Set the period to **This month**.
  2. Click **Received**, then **Clients owe**, then **Unapplied** to see each list.
  3. Open the **Invoices** tab and click **View invoice** on one.
- Done when: the invoice opens.
- Watch out: **Refund** sends money back to a card; never press it on camera outside the demo.

**Admin and owner tasks**

### Update practice info and add a location

- For: Admins
- Starts on: Practice Settings, **Practice info**.
- Needs in the demo: nothing.
- Steps:
  1. On the **Practice** card, click **Edit**, change **Office hours**, click **Save**.
  2. Click **Next: Locations**.
  3. Click **New location**, type **Name clients see**, **Place of service on the claim** (11 for an office), and the address.
  4. Click **Save location**.
- Done when: the new location shows in the list.
- Watch out: the practice logo shows only on client-facing pages, never inside the app. Holidays go under **Closures** on the same page: **Add closure**, **From**, **To**, **Reason**, **Every location** or **Only some**, then **Save**. Staff can still book on a closed day with a warning.

### Set up a clinician on the Team

- For: Admins
- Starts on: Practice Settings, **Team**, **People**.
- Needs in the demo: any clinician, such as Devon Hart.
- Steps:
  1. Click **Open** on the person.
  2. In **Credentials**, click **Edit**, fill **NPI**, **License type**, **License number**, **State**, **License expires**, **Signs notes as**, and save.
  3. For a supervised clinician, in **Supervision** click **Edit**, tick **Their notes need a co-signature**, pick **Co-signing supervisors** and **Supervising provider for claims**, and save.
- Done when: the People list shows their credentials on file.
- Watch out: the Team page has no button to add a new person. Use only the demo's NPIs (they are test numbers).

### Set a clinician's hours and time off

- For: Admins, Clinicians
- Starts on: **My account**, **Hours and time off**.
- Needs in the demo: nothing.
- Steps:
  1. In **Weekly hours**, click **Edit**, then **+ Add hours** on a day, set the times, and **Save**.
  2. In **Time off**, click **+ Add**, type From and to, and click **Save**.
- Done when: the hours and the time off show.
- Watch out: admins can also edit anyone's hours on Team, **Hours**, or set detailed hours per service in the Calendar's **Availability** view. Time off can also be added on the calendar as **Out of office**.

### Add or change a service and its fee

- For: Admins
- Starts on: Practice Settings, **Services**.
- Needs in the demo: the sample services.
- Steps:
  1. Click **Edit** on **Individual Therapy For Adults**.
  2. Change the rate, **Default duration**, or **Start times**.
  3. Tick clinicians under **Offered by** and places under **Where**.
  4. Click **Save**.
- Done when: the list shows the new rate and duration.
- Watch out: **Add a service** creates a new one; **Delete service** removes it from booking.

### Set up forms and packets

- For: Admins
- Starts on: Practice Settings, **Client forms**.
- Needs in the demo: the sample forms.
- Steps:
  1. On **Forms**, click **Preview** on a form.
  2. Open **Packets** and click **New packet**.
  3. Name it, add forms in order, and click **Save changes**.
- Done when: the packet lists with its form count.
- Watch out: editing a built-in form makes it the practice's own version.

### Preview the client portal and booking page

- For: Admins
- Starts on: Practice Settings, **Portal and booking page**.
- Needs in the demo: nothing.
- Steps:
  1. On **Client portal**, look at **Live preview**.
  2. Click **Sign in**, **Sessions**, **Documents**, **Billing**, **Account** to change the preview.
  3. Click the **Booking page** tab and step through **Start**, **Where**, **Who**, **What**, **Time**.
- Done when: each screen shows in the phone frame.
- Watch out: **Open** opens the real portal or booking page in a new tab; do not click it in the demo.

### Run reports for the month

- For: Admins
- Starts on: Reports (`/reports`).
- Needs in the demo: sample data.
- Steps:
  1. Choose **Last month** in the period.
  2. Click **Income**, then **Outstanding**, then **Provider collections**.
  3. On Provider collections, choose **Count claims by** **Payment date**.
- Done when: the provider table shows each clinician's total collected and payout.
- Watch out: **Download CSV** on Caseload saves a file; that is fine in the demo.

### Get enrolled with a payer

- For: Admins, Billers
- Starts on: Payer Enrollment (`/admin/claimmd/enrollment`).
- Needs in the demo: the sample payers.
- Steps:
  1. Find a payer marked **Needs enrollment**.
  2. Click **Open enrollment**.
- Done when: the demo shows its notice that it would file the enrollment.
- Watch out: **Update status** records what the payer said by phone or mail.

### Create a couples chart

- For: Front desk, Admins
- Starts on: Patients, **Couples**.
- Needs in the demo: does not work in the demo; record only in an environment Ashley approves.
- Steps:
  1. Click **New couples chart**.
  2. **Choose a client**, then under **Partner** choose **Already a client** or **Someone new**.
  3. Choose **Billing** (**Insurance** or **Self-pay**) and **Whose insurance is billed**.
  4. Click **Create couples chart**.
- Done when: the couples chart opens.
- Watch out: on the Patients list, ticking exactly two clients shows **Make a couples chart**. Couples sessions are booked one at a time.

### File a received fax

- For: Front desk, Billers
- Starts on: Fax (`/fax`), **Waiting to file**.
- Needs in the demo: the inbound fax waiting.
- Steps:
  1. Click **Open** on the fax.
  2. In **File this fax on a chart**, type a client name and pick them.
  3. Click **File it**.
- Done when: the fax leaves Waiting to file.
- Watch out: sending a fax starts on a chart. In the demo, **Send fax** sends nothing. Always use **Confirm fax number** carefully in a live practice.

**Client portal tasks**

These are shown through the Live preview in Practice Settings, **Portal and booking page**. The preview uses the sample client Jordan Lee. Treat it as look-only; do not record a client actually completing an action there.

### Show how a client signs in

- For: Clients in the portal
- Starts on: Portal and booking page, **Client portal**, Live preview, **Sign in**.
- Needs in the demo: nothing.
- Steps:
  1. Click **Sign in** above the preview. "Sign in to your portal" shows.
  2. Point out **Email or phone number** and **Continue**.
  3. Explain the next screens in your script: a six-digit code, then **Confirm your date of birth**, then **Save this device** or **Not now**.
- Done when: the sign-in screen is on camera.
- Watch out: a parent signing in for a child enters the child's date of birth.

### Show a client confirming, rescheduling or cancelling

- For: Clients in the portal
- Starts on: Live preview, **Sessions**.
- Needs in the demo: nothing.
- Steps:
  1. Click **Sessions**. Upcoming sessions show.
  2. Point out **Confirm**, **Reschedule** and **Cancel** under a session.
- Done when: the session card with its buttons is on camera.
- Watch out: reschedules and cancellations ask the client for a reason and show on the practice's calendar card and on Appointments.

### Show a client's paperwork, billing and account

- For: Clients in the portal
- Starts on: Live preview.
- Needs in the demo: nothing.
- Steps:
  1. Click **Documents**: paperwork to sign and completed forms.
  2. Click **Billing**: balance and **Pay now**.
  3. Click **Account**: **Your practice**, **Text messages**, **Sign-in**, **Sign out**.
- Done when: each screen has been shown.
- Watch out: a clinician's signed letter or a plan to sign also lands under Documents.

## Words the app uses

| Word | Meaning |
|---|---|
| Needs note | A session that happened and has no progress note yet. |
| Draft | Saved but not signed. Not part of the record. |
| Signed, Signed and locked | Final. The note or plan cannot be changed, only marked entered in error or reviewed. |
| Awaiting supervisor signature, Out for co-signature | A supervised clinician signed; the supervisor still has to co-sign. |
| Returned for edits, Sent back | The supervisor sent the note back with what to change. |
| Entered in error | A signed note marked as a mistake. It stays in the record, struck from use. |
| Chart note | A note about something outside a session (a call, an email). Not billed. |
| Psychotherapy notes | A clinician's private process notes, kept apart from the chart. |
| Treatment progress | The note editor tab showing progress on the client's plan objectives. |
| Confirmed, Showed, No Show, Late Cancellation, Cancelled, Clinician Cancellation, Reschedule requested | Session statuses. Showed means attended and becomes a charge. |
| Availability | When a clinician can be booked. Booking outside it is allowed with a warning. |
| One-off days | Days open once, on top of the weekly hours. |
| Event | A calendar block that stops new bookings (for example supervision). |
| Out of office | Time off on the calendar; can cancel sessions inside it. |
| Closure | A day a location is closed; online booking is blocked. |
| Default appointment | A client's usual clinician, place and service, filled in when booking. |
| Packet | A set of forms sent together with one link. |
| Measure | A scored questionnaire such as PHQ-9 or GAD-7. |
| Coverage | The client's insurance and billing setup (the chart tab). |
| Self-pay | The client pays; nothing is billed to insurance. |
| Session authorization, EAP | A set number of sessions paid by an employer program, voucher, grant or pre-authorization. |
| Place of service | The two-digit code for where a session happened (for example 11 office, 10 or 02 telehealth). |
| Rendering provider | The clinician who saw the client, with their NPI, on the claim. |
| Supervising provider | The supervisor named on a supervised clinician's claims. |
| To be submitted | Sessions billed to insurance with no claim yet. |
| Ready, Needs info, Blocked | Whether a session in To be submitted can become a claim. |
| Not submitting | Sessions held back from insurance, with a reason. |
| Claims center | The Insurance page. |
| Submitted, Paid, Rejected, Denied, Needs review, Not sent | Claim statuses. Rejected never reached the payer; Denied was refused by the payer. |
| Waiting on enrollment | A claim held until the practice is enrolled with that payer. |
| Fix and resend | Correct a rejected or denied claim and send it again. |
| EOB | The payer's explanation of benefits: what it paid and why. |
| ERA, remittance | The electronic version of the EOB, pulled with **Pull remittances**. |
| With insurance, Awaiting insurance | Money still waiting on a payer's answer. |
| Client owes | What the client still has to pay after insurance and write-offs. |
| Client share not yet known | Insurance has not answered, so the client's part is unknown. |
| Decide client share | The payer paid part without saying why; the biller decides how much is write-off. |
| Write-off | An amount taken off a balance. On an EOB it is the contractual adjustment. |
| Contractual adjustment | The part of the fee the payer's contract says is not collected. |
| Credit on file, Unapplied | Money paid that is not yet on a session or invoice. |
| Unclaimed | Insurance money received with no claim in LeadDash attached. |
| Allocated, Unallocated | Whether an insurance payment has been put against claims. |
| Invoice | A bill to the client for sessions. |
| Not yet invoiced | Sessions the client owes on that are not on an invoice. |
| Void | Cancel an invoice; its sessions go back to Not yet invoiced. |
| Statement | Every invoice, payment and credit in a date range. |
| Superbill | A receipt the client sends to their own insurer. |
| AutoPay | Each new invoice is charged to the client's saved card. |
| Received, Deposited, Refunded, Payouts | Money in, money that reached the bank, money sent back, and Stripe's transfers to the bank. |
| Provider collections | What each clinician's sessions collected, for payroll. |
| Privacy mode | Shows client names as an initial and surname on screen. |
| Admin note | A note for the office on a chart, not clinical. |
| My room | A clinician's own telehealth room. |
| DashNotes | The recorder that drafts a note from a session recording or dictation. |
| Waiting to file | A received fax not yet put on a chart. |

## Never

- Never use a real practice or real client data. Work only at https://demo.leaddash.io, or at https://ehr.leaddash.io signed in to Maple Crest Counseling (the Demo Account). Never sign in at app.leaddash.io or any other LeadDash address, and never in any other practice.
- Never fill in the demo's sign-up form ("Open the demo"). It sends a real lead to LeadDash. Use the team link from Ashley.
- Never type a real person's name, birth date, phone, email, address, insurance number, diagnosis or any health detail anywhere, even in the demo. Use made-up names, 555 phone numbers and example.com emails.
- Never send real messages, faxes, texts or emails to real people. Do not use the "Send a test" email button with a real address.
- Never charge a real card or enter real card numbers. Never press **Refund** outside the demo.
- Never submit a real claim, a real payer enrollment, or a real eligibility check.
- Never delete anything outside the demo. In the demo, avoid **Delete appointment**, **Delete claim**, **Delete visit** and **Void invoice** unless the video is about that action.
- Never click **Log out** in the demo; it ends the demo session.
- Never click **Start your practice** in the demo bar on camera; it leaves the demo for the pricing page.
- Never click links that open outside sites from the demo: **Join session**, **Open room**, **Join** or **Open Google Meet** (Dashboard and calendar), **Open** on the portal or booking page settings, **Manage in Stripe**, **Respond in Stripe**, **Receptionist** and **Community**.
- Never reload the page in the middle of a recording. A reload, the header's **Search clients...** result, the Settings breadcrumb **Dashboard** link, or **Start over** all reset the demo and lose your changes.
- Never click the **Dashboard** link in the Calendar or Settings breadcrumb; it goes to an address that leaves the demo. Use **Dashboard** in the left menu.
- Never use the demo's DOB, diagnosis or medication sample values as if they were real; keep them off script narration where you can.
- Never show or read out the team link's code on camera.
- Never put a practice's own logo inside the app in a video; the LeadDash EHR logo stays on every app screen, and a practice logo belongs only on client-facing pages.
