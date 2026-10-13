# LeadDash Events

A guide for recording demo videos, training videos and written SOPs of LeadDash Events. Every label below was read from the app's code. When a label is shown in quotes or bold, type or click exactly that text.

LeadDash Events has three parts:

- **The admin**, where an organization sets up and runs its events (`/admin`).
- **The attendee app**, one per event, branded with the event's look (`/e/<event address>`).
- **Public pages** that need no admin sign-in: the attendee checkout page, the sponsor and exhibitor checkout pages, agreement signing, the speaker page, the call for proposals and the certificate check.

## Where and how

### Web address

- Admin: https://events.leaddash.io/admin
- Start page: https://events.leaddash.io (signed out, it shows the same sign-in page; signed in, it shows **Your events** and an **Open the admin** button)
- Attendee app for an event: https://events.leaddash.io/e/<event address>
- Checkout page for an event: https://events.leaddash.io/r/<event address>

The event address (the "slug") is made from the organization name and the event's short name. You can always read it on **Event settings** (the **Attendee app link** line) or on **Branding** (the **App address** line).

### How staff sign in

There are no passwords. Everyone signs in with an emailed six-digit code.

1. Open https://events.leaddash.io/admin.
2. The sign-in page shows **Sign in** and "Enter your email. We will send you a six-digit code."
3. Type the email in **Email** and click **Email me a code**.
4. The card changes to **Check your email** with "Code sent to <email>". Open that inbox. The email subject is "Your sign-in code: <code>".
5. Type the six digits into the six boxes (pasting the code fills all six) and click **Sign in**.
6. You land on **Events**.

Notes:
- The code works for 15 minutes. **Send a new code** sends another; **Use a different email** goes back.
- After 3 code requests in one minute the app says "Please wait a minute before asking for another code."
- A wrong code says "That code is not right. Check the email and try again." After 5 wrong tries, ask for a new code.
- Simone needs access to the inbox of the email she signs in with.
- Sign-in lasts 30 days unless you click **Sign out** at the bottom of the admin menu.

Who can open what:
- **Organization owner and admins** (the organization's **Admin team**) can do everything for every event of that organization.
- **Event staff** get only the pages their **Staff role** allows. They sign in the same way; they do not see the organization pages.
- **LeadDash staff** (emails set on the server) have tech-support access to every organization and see an extra **LeadDash tools** page. They are never shown on an organization's admin team.
- An email that is on no admin team sees "Your email is not on an organization's admin team yet. Ask the organization's owner to add you."

### Which organization and event to use

- **There is no built-in demo or sample event in the code.** Nothing is created automatically except the defaults every new event gets (listed below). Check the Events page for an organization made for demos before you start.
- Use only an organization and event made for demos. Ask Ashley (LeadDash staff) to set one up if none exists:
  - LeadDash staff click **New organization** on **Events**, fill **Organization name** (use a generic name such as "Demo Organization"), **Owner's name** and **Owner's email** (an inbox Simone can read), then **Create**.
  - Each organization may add only the number of events LeadDash includes (1 by default). LeadDash staff change it on **LeadDash tools** in the **Events** section (**Events included**).
- Events are never deleted, and every event counts toward that number. Do not create test events in a customer's organization.
- Pick demo event dates that include the days you record. Room check-in in the app only works from 30 minutes before a session starts until 15 minutes after it ends, so a session must be happening while you record that part.
- Once an event's last day is over (in its time zone), its dates and status lock. Only LeadDash staff can move them (**LeadDash tools**, **Change dates**).

### What a new event already has (useful sample data)

When an event is created, the app adds:
- **Tickets**: Member, Nonmember and Student, each at $0.00 and turned **Off**.
- **Who is registering (buyer choices)**: Member (asks for a member ID), Non-member, Student (asks for school).
- **Checkout page** questions: Name and email (always asked), Mobile number, Credentials, License number and state (for CE), Dietary needs, Accessibility needs. Button label "Register".
- **Welcome emails** for attendees: Welcome email, Text with the app link, App reminder email, Know before you go, Morning-of text (off).
- **Evaluation form**: "Standard session evaluation" (Default) with four questions.
- **Certificate template**: "CE certificate", titled "Certificate of Completion".
- **Staff roles**: Event admin, Check-in volunteer, Proposal reviewer, Booth staff, Speaker.
- **Agreements**: Sponsor agreement <year>, Exhibitor agreement <year>, Speaker agreement <year>.
- **Community topics**: General, Introductions, Ask the organizers (pinned, by the event team).
- **Help**: a help desk at "Registration desk" and common questions with placeholders in brackets (for example "[WIFI NAME]").
- **Sponsor and exhibitor checkout pages**, both **Closed** until someone opens them.

Sample data to add before recording (all with made-up names and team-controlled email addresses):
- 2 or 3 tickets with prices, one with early bird pricing, and one $0.00 ticket so you can show a full free registration without a card.
- 4 to 6 sessions across the event days, some with CE hours, with speakers (the CSV import is fastest).
- 2 speakers with headshots and bios.
- 2 packages (one sponsor, one exhibitor booth), one add-on, and one sponsor with a recorded payment.
- 3 to 5 demo attendees, including one with Simone's own email so she can open the attendee app as an attendee.
- A floor plan image for the venue map.

## The menu

### Admin sidebar (dark, on the left)

From top to bottom:

1. **LeadDash Events** logo (goes to **Events**).
2. **Find a page** search box. Typing filters the menu and opens the matching groups. Enter opens the first match; Escape clears it. "No page matches." shows when nothing fits.
3. **Event card**: the event name and dates. For organization admins, clicking it opens a list of the organization's events (with " · Draft" or " · Ended" after the dates) and **All events**. Pick one to switch.
4. **Event home** (`/admin/e/<id>`).
5. The event's groups. Only the group you are in stays open; click a group name to open it.

| Group | Page | Path |
|---|---|---|
| **Program** | Sessions | `/admin/e/<id>/sessions` |
| | Speakers | `/admin/e/<id>/speakers` |
| | Proposals | `/admin/e/<id>/proposals` |
| **Tickets and sales** | Tickets | `/admin/e/<id>/registration?tab=tickets` |
| | Sponsors and exhibitors | `/admin/e/<id>/vendors` |
| | Sales and payments | `/admin/e/<id>/registration?tab=payments` |
| | Checkout page | `/admin/e/<id>/registration?tab=checkout` |
| | Welcome emails | `/admin/e/<id>/registration?tab=welcome` |
| **People** | Attendees | `/admin/e/<id>/attendees` |
| | Check-in desk | `/admin/e/<id>/checkin` |
| | Staff roles | `/admin/e/<id>/staff` |
| **CE** | Evaluations | `/admin/e/<id>/evaluations` |
| | Certificates | `/admin/e/<id>/certificates` |
| **In the app** | Announcements | `/admin/e/<id>/announcements` |
| | Community | `/admin/e/<id>/community` |
| | Photos | `/admin/e/<id>/photos` |
| | Help | `/admin/e/<id>/help` |
| | Dining | `/admin/e/<id>/dining` |
| | About host | `/admin/e/<id>/host` |
| **Setup** | Branding | `/admin/e/<id>/branding` |
| | Agreements | `/admin/e/<id>/agreements` |
| | Reports | `/admin/e/<id>/reports` |
| | Event settings | `/admin/e/<id>/settings` |

Pages that hide:
- **Sponsors and exhibitors** hides when the event turned off "Exhibitors and sponsors". **Community** hides when "Community" is off. **Photos** hides when "Photos" is off. **Dining** hides when "Food and dining" is off. These switches are on **Branding**, section **In the app**.
- **Staff roles**, **Dining**, **About host**, **Branding** and **Event settings** show only to organization admins and the Event admin role.
- Event staff see only the pages their role opens.

6. Organization pages, under the organization's name:
   - **Events** (`/admin`)
   - **Payments** (`/admin/payments`)
   - **Organization settings** (`/admin/settings`)
7. **LeadDash tools** (`/admin/leaddash`) under "LeadDash staff", only for LeadDash staff.
8. **Sign out** at the bottom.

Across the top of every admin page are breadcrumbs: organization name › Events › event name › page name. On a phone, the **Menu** button opens the sidebar.

### Attendee app

Bottom tabs (only the ones the event turned on show):
- **Home** (`/e/<slug>/home`)
- **Agenda** (`/e/<slug>/agenda`)
- **People** (`/e/<slug>/people`), when "People directory" is on
- **Community** (`/e/<slug>/community`), when "Community" is on
- **Messages** (`/e/<slug>/messages`), when "Attendee messaging" is on; shows an unread count

Other app pages:
- `/e/<slug>` welcome and sign-in (signed-in people go to Home)
- `/my` My agenda · `/session/<id>` session · `/speakers` speakers · `/alerts` alerts · `/more` More (no button in the app links here; type the address)
- `/dining` and `/nearby` Food and dining · `/host` About your host · `/help` Help center · `/lost-found` Lost and found
- `/checkin/<sessionId>` room check-in · `/eval/<sessionId>` evaluation · `/credits` CE credits · `/transcript` CE transcript · `/badge` My badge
- `/people/<id>` a profile · `/profile` My profile · `/messages/<id>` a conversation · `/meet/<id>` Request a meeting
- `/community/new` Start a discussion · `/community/<id>` a topic
- `/exhibitors?tab=sponsors|exhibitors` Exhibitors and sponsors · `/exhibitors/<id>` one company · `/map` Venue map
- `/poll/<sessionId>` Live poll and Q&A · `/leads` Scan leads · `/photos` Photos

### Public pages

- `/r/<slug>` checkout page · `/r/<slug>/register` · `/r/<slug>/pay` · `/r/<slug>/done`
- `/r/<slug>/sponsor` and `/r/<slug>/exhibit` (plus `/done` and `/pay` after each)
- `/sign/<code>` sign an agreement · `/agreement/<code>` signed copy (`/pdf` for the PDF)
- `/speak/<token>` speaker page
- `/embed/<slug>` and `/embed.js` (website embed)
- `/get/<slug>` Get the app
- `/cfp/<slug>` submit a proposal
- `/cert/<code>` certificate and its check

## Screens

How editing works everywhere in the admin:
- **Sections** show values read-only with an **Edit** button. **Edit** shows an orange **Editing** pill and opens compact fields with **Save** and **Cancel**. Nothing changes until **Save**. Clicking a value never edits it.
- **List rows** have one button on the right (all the same width, in one column), usually **Details**, **Open** or **Edit**. It opens the row in place below itself and turns into **Close**.
- **Folder tabs** (tabs with a lip along the top of a card) filter busy lists.
- A thin **number strip** of labels and bold numbers runs across the top of many pages.
- Small messages ("toasts") confirm saves, for example "Saved".
- Delete buttons ask "Delete <name>?" in a browser box first.

### Admin sign-in page

For: everyone using the admin. Left: the LeadDash Events logo, "Events that bring people further.", "Plan. Connect. Engage. All in one place." and four features (Registration and checkout; Agenda, check-in and badges; CE certificates, sent for you; Sponsors and exhibitors). The card: **Sign in**, **Email** (placeholder "you@company.com"), **Email me a code**, and "Attendees: open your event's app link to sign in." Second step: **Check your email**, six code boxes, **Sign in**, **Use a different email**, **Send a new code** (changes to "New code sent").

Source: client/src/core/AdminSignIn.tsx

### Start page

`/` when signed in. **Open the admin** (only for organization admins and LeadDash staff), then **Your events**: a tile per event the person can open (as attendee, staff or admin), each opening `/e/<slug>`. Empty: "No events yet for <email>."

Source: client/src/core/screens.tsx

### Events

`/admin`. Title **Events**. Buttons: **New organization** (LeadDash staff only), **New event** (blue). LeadDash staff also see an **Organization** picker and a gray **Tech support** pill; admins of more than one organization see an **Organization** picker.

Table columns: **Event**, **Dates**, **Venue**, **Status** (pill: Live, Draft or Ended), and an **Open** button.

**New event** opens a box titled **New event**: **Event name** (placeholder "Annual Conference"), **Short name (app header)** (placeholder "Conference 2027"), **Time zone** (New York, Chicago, Denver, Phoenix, Los Angeles, Anchorage, Honolulu), **Starts**, **Ends**, **Venue or hotel name**, **Street address**, **City**, **State**, **ZIP code**, then **Create** and **Cancel**. After **Create** you land on the new event's home.

When the organization has used all its events, **New event** opens **Your account includes 1 event** (or N events) with the events listed, **Close** and **Email LeadDash**.

Source: client/src/core/screens.tsx

### Organization settings

`/admin/settings`. Two cards.

- **Organization** section with **Edit**. Read view: **Name**, **Brand colors** (Main, Buttons, Highlight with "Same as main" when not set), **Logo**. Edit: **Name**, **Main color**, **Button color**, **Highlight color** (with a **Same as main** button), **Logo** (**Upload** or **Replace**), and the checkbox **Use these colors and logo on every event**. Saving says "Saved" or "Saved. N events use the new look." Events that still use the organization's look follow the change; an event with its own look keeps it unless the checkbox is on.
- **Admin team**: each person with name, email and an Owner or Admin pill. The owner sees **Make owner** and **Remove** on admins. **Make owner** opens "Make <name> the owner?" with three notes and **Transfer ownership** and **Cancel**. Under the list (owner only): **Name**, **Email** and **Add**, which says "Added. They sign in with their email."

Source: client/src/core/screens.tsx

### Payments (organization)

`/admin/payments`. Title **Payments**. A banner across the top says "Connect Stripe before the checkout page can take payments", "Stripe needs more details before the checkout page can take payments", or "Stripe connected: <name> · <payouts>".

- Not connected: **Get paid with Stripe**, three steps (Click Connect with Stripe; Sign in to Stripe (or create an account) and allow LeadDash; Come back here; the checkout page turns on) and the purple **Connect with Stripe** button.
- Connected: **Stripe account** section with **Edit** (Status, Account, Payouts to, Name on card statements, Ways to pay, Klarna, Afterpay, Receipts, Refunds, LeadDash fee). Edit fields: **Name on card statements** and **Refund policy**. Buttons: **Open Stripe dashboard**, **Turn on Klarna or Afterpay** (when either is off), **Finish setup in Stripe** (when not finished), **Check status**, **Disconnect**. A side card **Where the money goes**. Below: **Recent payments** (Date, Attendee, Event, Ticket, Amount, Status) with a **Refund** button on paid rows; other rows open with **Details**.

One Stripe account serves every event of the organization.

Source: client/src/areas/registration/admin.tsx

### LeadDash tools (LeadDash staff only)

`/admin/leaddash`. Subtitle "<organization> · Only LeadDash staff see this page". Sections: **Events** (Events included, Events added, **Edit**; each event row with **Change dates**, which works only after the event ended), **Owner** (**Edit** to pick a **New owner** from the admin team), **LeadDash platform** (Marketplace app, Agency authorization, sub-account, **Authorize the agency**, **Save**). Do not record this page for customers.

Source: client/src/core/screens.tsx

### Event home

`/admin/e/<id>`. Title is the event name; subtitle the dates and venue. Number strip: **Registered**, **Sales** (only for people who can see registration), **Sessions**, and **Days to go** (or **Event**: Today or Ended). A **Getting ready** card lists what is left with "N of M done", each with **Open**: Connect Stripe, Add tickets, Set the app's look, Add sessions, Add speakers, Set up CE certificates, Open the app to attendees. The card disappears when everything is done.

Source: client/src/core/screens.tsx

### Sessions

`/admin/e/<id>/sessions`. Title **Sessions**. Buttons: **Send announcement** (goes to Announcements), **Import**, **Add session**. On the Slides tab the first button is replaced by **Download all slides** and **Remind missing**.

Number strip: **Attendees**, **Sessions**, **Check-ins**, **Certificates issued**.

Folder tabs: **All (N)**, **Day 1**, **Day 2** and so on (for multi-day events), **Slides (N missing)**.

Table columns: **When**, **Session**, **Room**, **CE**, **Scheduled**, **Checked in**, **Evaluations** (shows "Opens <time>" before a CE session ends), and **Details**. Hidden sessions show a gray **Hidden** pill.

**Add session** opens a **New session** card: **Title**, **Kind** (Session, Keynote, Workshop, General session, Break, Meal), **Date** (limited to the event dates), **Start**, **End**, **Room**, **Track**, **CE hours**, **Evaluation form** (Event default or a form), **Certificate template**, **Evaluation opens** (When the session ends, At check-in), **Certificate issued** (Template rule, After evaluation, After check-in), **Seats** (placeholder "No limit"), checkboxes **Attendees sign up (seats are limited)** and **Show on the agenda**, and **Description**. Then **Save** and **Cancel**.

An open row shows:
- **Session details** with **Full page** and **Edit** (Presenter or Speakers, Time, Room, Kind, Track, CE hours, Room code, Evaluation opens, Evaluation form, Certificate template, Certificate, Evaluations in, Seats, On the agenda, Description).
- **Speakers** with **Edit**: each speaker with a role (Presenter, Co-presenter, Moderator, Panelist) and **Remove**, and an **Add a speaker** picker.
- **Slides and handouts** with **Edit** (not for Break or Meal): files with **Download** and **Remove**; Share with attendees (After the session starts, Right away, Do not share), Due date for speakers, Downloads. Edit adds **Upload file** (PDF, PowerPoint or Word, up to 100 MB).
- **Print door QR** and **Attendance list** (Name, Email, License, Agenda, Checked in, with **Download**).

Slides tab columns: **Session**, **Speaker**, **Slides** (pill "1 file" or orange **Missing**), **Shared**, and **Download** or **Remind**.

Source: client/src/areas/program/adminProgram.tsx, client/src/areas/program/SessionSlides.tsx

### Session page

`/admin/e/<id>/sessions/<sessionId>`. Title is the session title. Buttons: **All sessions**, **Delete** (asks "Delete <title>? It comes off every attendee's agenda, and its check-ins go with it."). Number strip: **Scheduled**, **Checked in**, **Evaluations**, **Seats left**. Left card: Session details and Speakers; right card: Slides and handouts. Then **Room check-in QR** with the QR code, the **Room code**, "Post this at the door...", **New code** (asks first; printed codes stop working) and **Print**. Then **Attendance** with **Download**.

Source: client/src/areas/program/adminProgram.tsx

### Import sessions or speakers

Opens from **Import** on Sessions or Speakers. Title **Import sessions** or **Import speakers**. Two steps: **1. Choose a file** and **2. Check the rows**.

- Step 1 lists the columns (required ones are green). Sessions: Title, Date, Start time, End time (required), Room, Track, Type, CE hours, Speakers, Description. Speakers: First name, Last name (required), Credentials, Job title, Organization, City, Email, Website, Bio. Notes on formats: dates like the event's first date or 3/11/2027, times like 10:30 AM, several speakers separated by a semicolon, Type is Session, Keynote, Workshop, Break, Meal or General. A drop area "Drop a CSV file here" with **Choose file** (then **Choose another**). Buttons: **Download template**, **Cancel**, **Next**.
- Step 2 shows counts (Sessions ready, New speakers, Already on the agenda, Need a fix) and each row with a pill: **Ready**, **Adds details**, **Already added**, **Needs a fix** (with the problem in red). Buttons: **Back**, **Cancel**, **Import N sessions** (or **Import N speakers**, or **Update N speakers**).
- Done: a green banner ("N sessions added to the agenda"), counts, and **Open Speakers** (when new speakers were made) and **Done**.

Nothing is saved until the import button in step 2.

Source: client/src/areas/program/importProgram.tsx

### Speakers

`/admin/e/<id>/speakers`. Title **Speakers**. Buttons: **Edit agreement** (opens Agreements on the speaker agreement), **Send agreements**, **Import**, **Add speaker**.

Folder tabs: **All (N)**, **Signed (N)**, **Not signed (N)**, **Slides missing (N)**.

Columns: **Speaker** (photo, name, **Featured** pill), **Session**, **Agreement** (green "Signed <date>", orange "Sent <date>", red **Not sent**), **Welcome email** (**Welcome sent** or **Waiting**), and **Open**.

An open row shows a **Speaker** card (Email, Session, Bio and photo, Slides) with **Edit**, and **Agreement and emails** (Agreement, Sent, Signed, Recording, Welcome email) with **View PDF** or **Resend** or **Send**, **Copy sign link**, and **Send welcome**.

**Edit** (or **Add speaker**) opens: **Upload headshot** or **Replace headshot**, **Remove**, **First name**, **Last name**, **Credentials**, **Title**, **Organization**, **City**, **Email**, **Website**, **Order**, **Bio**, **Attendees can message this speaker**, **Featured (shown first)**, a **Sessions** list with **Remove** and an **Add a session** picker. Then **Save** and **Cancel**. Below it, a red **Delete**.

The speaker's full page (`/speakers/<id>`) has **All speakers**, and a **Speaker profile** section with **Request update** (emails the speaker asking for missing items) and **Edit**.

Source: client/src/areas/program/adminProgram.tsx, client/src/areas/agreements/SpeakerAgreementBits.tsx

### Call for proposals

`/admin/e/<id>/proposals`. Title **Call for proposals** (reviewers who see only their own queue get **Proposals to review**). People who are both see folder tabs **All proposals** and **My reviews**.

Admin view: **Copy proposal link**, **Assign reviewers evenly**; number strip **Submitted**, **Fully reviewed**, **Accepted**, **Declined**; a **Call settings** section with **Edit** (Status, Guidelines, Opens, Due date, Formats, Tracks, Scores, Blind review, Reviews per proposal, Reviewers, Proposal link). Edit has **Opens**, **Due date**, **Reviews per proposal**, **Blind review**, a formatted-text box **Guidelines on the proposal page** (toolbar Heading, Subheading, B, I, U, Bullets, Numbers, Link, Clear), **Formats** and **Tracks** (one per line), **Scores reviewers give** with **Add score**.

Folder tabs: **All**, **Needs decision**, **In review**, **Accepted**, **Waitlist**, **Declined**. Columns: **Proposal**, **Submitted by**, **Track**, **Avg score**, **Status**, **Details**. An open proposal shows the details, a **Reviewers** checklist (with **Save** when changed), the **Reviews** table and **Decide**.

**Decide** opens a side panel **Decide**: **Accept** (with **Session time** and **Room** when it is not on the program yet), **Waitlist**, **Decline**; emails **Send the acceptance email** (or "Email <name> the decision"), **Send the speaker agreement to sign**, **Send the speaker welcome email after they sign**; **Note to the speaker (optional)**; **Save** and **Cancel**.

Reviewer queue: strip **Assigned to you**, **Left to review**; rows with **Review** (or **Details**), score pickers, **Recommendation** (Accept, Maybe, Decline), **Comment for the committee**, **Submit review** or **Update review**.

Source: client/src/areas/network/admin-proposals.tsx

### Tickets, Checkout page, Welcome emails, Sales and payments

One page at `/admin/e/<id>/registration`; each menu item opens a tab and the title changes to **Tickets**, **Checkout page**, **Welcome emails** or **Sales and payments**. Every tab has **View checkout page** (opens `/r/<slug>` in a new tab), **Copy link**, and the Stripe banner (with **Payments settings**, which opens Sales and payments).

**Tickets**
- Number strip: **Registered**, **Capacity**, **Revenue**, and **Early bird ends** (amber) when one is set.
- **Ticket types** with **Add ticket**. Columns **Ticket** (gray **Off** pill when off, **Members only** pill), **Who can buy**, **Price today** (with an Early bird or Late pill), **Sold**, and **Edit**.
- Ticket editor (**New ticket** or **Editing ticket**): **Ticket name**, **Includes** (All N days, One day, Workshop only), **How many** (placeholder "No limit"), **On sale** (On, Off), **Details (buyers tap Details)**, **Badge ribbon**, **Stop selling after**, **Who can buy it** (chips of the buyer choices; or Anyone / Members only (asks for member ID) when there are no buyer choices). **Price by date** rows: **Early bird** (checkbox, price, Ends date), **Regular**, **Late** (checkbox, price, Starts date); one price column per buyer choice picked. A box **What buyers see today (<date>)** previews the price. **Save**, **Cancel**, and **Delete** (only when none sold).
- **Who is registering (buyer choices)** section with **Edit**: each choice has **Name**, **Asks for a member ID**, **Asks for school**, **Code (optional)** and **Remove**; **Add choice**.
- **Coupons** with **Add coupon**. Columns: code, discount, "Used N of M", "Ends <date>", **Edit**. Editor: **Code**, **Discount** (Percent off, Amount off), **Percent** or **Amount**, **Max uses**, **Ends**, **Coupon is on**; **Save**, **Cancel**, **Delete** (only when unused).

**Checkout page**
- Folder tabs **Attendees**, **Sponsors**, **Exhibitors**.
- Attendees: a **Page** section with **Edit** (Cover image, Headline, Short description, Button label, Tickets on the page, Questions at sign-up, Pay over time, After payment). Edit: cover **Upload**/**Replace**/**Remove** ("JPG or PNG, 1600 x 900 or larger"), **Headline**, **Short description**, **Button label**, **Tickets on the page** (All N ticket types, Pick ticket types), **Questions at sign-up** with **Required** checkboxes, **Remove**, and **Add question** (pick a preset or **Your own question** with **Question text**, **Answer**: Short answer, Long answer, Pick from a list, then **Add**), **Offer Klarna and Afterpay at checkout**, and under **After payment**: **Show the confirmation page with the Get the app button**, **Send the welcome email**, **Add the person to the LeadDash platform with the tag "..."** (with a **Tag** field). A **Share** area: **Direct link** with **Copy**, **Embed on your website** (Checkout form on the page, or Register button that opens a popup) with **Copy code**. A live **Preview** on the right.
- Sponsors and Exhibitors: **Sponsor checkout link** (or Exhibitor) with **Copy link**, **Embed code**, **Preview**, and a **Sponsor page** (or Exhibitor page) section with **Edit**: **Page** (Open, Closed), **Closes on**, **Title**, **Intro**, **Packages on the page** (or Booths), **How sponsors can pay** (**Pay in full**, **Pay a deposit**, **Pay by invoice**), **Payment methods** (Card and bank account, Bank account (ACH) only, Card only), **Deposit** (10% to 90%) and **Rest charged on**, **Hold for invoices** (7, 14 or 30 days), **Agreement to sign**, **Email new sponsors to**. The read view has an **Edit agreement** (or **Agreements**) button.

**Welcome emails**
- Folder tabs **Attendees**, **Speakers (N)**, **Sponsors (N)**, **Exhibitors (N)**.
- Attendees: **Welcome email** with **Send me a test** and **Edit** (Send, From name, Reply-to, Subject, Message, Include in the email, Status). Edit: **Send** (Right after payment, 1 hour after payment), **From name**, **Reply-to**, **Subject**, **Message**, **Insert a field** (First name, Ticket name, Amount paid, Event dates, Venue, App link), **Include in the email** checkboxes, **Hotel booking link**, **Send the welcome email**; **Save**, **Cancel**, **Send me a test**. Then **Follow-up messages** rows with **Edit** (Status, timing, Subject, Message or Text, **Send me a test**). "Texts go only to people who agreed to texts at sign-up." A **Preview** on the right.
- Speakers, Sponsors, Exhibitors: **Welcome email** with **Send me a test**, **Send to new** and **Edit** (Send choices such as After they sign the speaker agreement, When their proposal is accepted, Only when I send it; After payment and a signed agreement, Right after payment), field chips, include options; **Follow-up messages** rows (for example Slides reminder, Pass names reminder, Logo and ad reminder, Booth number assigned).
- **Send me a test** always goes to the signed-in person's own email.

**Sales and payments**
- Same Stripe content as the organization **Payments** page, for this event, with **Recent payments** (Date, Attendee, Ticket, Amount, Status) and **Refund**. Event staff who are not organization admins see "An organization admin connects Stripe on the organization's Payments page."

Source: client/src/areas/registration/admin.tsx, client/src/areas/registration/vendorCheckoutAdmin.tsx, client/src/areas/registration/welcomeTabs.tsx

### Sponsors and exhibitors

`/admin/e/<id>/vendors`. Title **Sponsors and exhibitors**. Buttons: **Export** (Sponsors, Exhibitors and Packages tabs) and **Add sponsor**, **Add exhibitor**, **Add package** or **Add add-on** for the tab.

Number strip: Sponsors and Exhibitors tabs show **Sold**, **Paid**, **Owed**, **Passes used**; Packages shows **Packages**, **Sold**, **Value sold**.

Folder tabs: **Sponsors (N)**, **Exhibitors (N)**, **Packages (N)**, **Add-ons (N)**, **Venue map**.

**Sponsors and Exhibitors tabs**: columns **Company**, **Package** (or **Booth**), **Price**, **Paid** ("No charge", "$X owed" or "Paid"), **Passes**, **Status**, and **Open**. Opening a row changes the address to `/vendors/<id>`. The open row has section cards:
- **Sponsor details** (or **Exhibitor details**) with **Edit**: Package, Price, Also an exhibitor (or Booth and Also a sponsor), Contact, Email and phone, Status, Agreement, In the app. Under it, the agreement line: **View PDF** and **Resend**, or **Send agreement**. Edit: **Package**, **Price for this sponsor**, **Also an exhibitor**, **Booth number**, **Contact**, **Email**, **Phone**, **Status** (Active or Cancelled), **Agreement template**.
- **Payments** with **Record**: Package price, Paid, Owed, each payment (with **Remove** when it was recorded by hand), the **Next charge** row with **Charge now** and **Change date**, and **Send invoice** and **Copy pay link** when money is owed. **Record** opens **Amount**, **How paid** (Card, Bank account, Check, Cash, Invoice, Other), **Paid on**, **Note or check number**.
- **Event passes (N of M)** (or **Booth staff passes**): each person with **Checked in** or **Not yet** and **Remove**; **Add person**.
- **Benefits**: a checklist; each item shows **Done**, **Waiting** or **To do**.
- **In the app** with **Edit**: Listed in the app, Logo, Category, Website, Booth offer, Lead scanning, Notes. Edit: **Company**, **Category**, **Website**, **Booth offer**, **About**, **Booth staff emails** ("Separate with commas. They can scan badges for leads."), **Notes (team only)**, logo **Upload**/**Replace**/**Remove**, **List in the attendee app**, **Booth staff can scan attendee badges for leads**.
- A red **Delete** at the bottom.

**Add sponsor** box: **Company**, **Contact**, **Email**, **Package**, **Add**, **Cancel**.

**Packages tab**: columns **Package**, **Price**, **Sold**, **Includes**, **Move up**, **Open**. Package section with **Edit**: **Name**, **Price**, **How many to sell**, **Kind** (Sponsor, Exhibitor booth), **Event passes included** (or Booth staff passes included), **Passes use ticket**, **Where the logo shows in the app** (Welcome screen, Top of the sponsors list, Session pages they sponsor), **Includes a booth**, **Benefits (one per line...)**; **Save**, **Cancel**, **Delete**.

**Add-ons tab**: columns **Add-on**, **Price**, **Available**, **Offered with**, **Open**. Editor: **Name**, **Price**, **How many to sell**, **Offered with** (booth checkboxes and **Sponsor packages**), **Adds a booth staff pass**.

**Venue map tab**: **Add a floor** with a floor name box (placeholder "Level 1") and **Upload map**. Each floor is a card with **Edit** and **Delete map**. Edit: **Name**, **Order**, **Image** (**Replace**), "Click the map to add a" (room, booth, service, meeting spot), the map (click to drop a pin), and each pin's **Label**, **Kind**, **Across %**, **Down %**, **Remove**. "Booth pins named like "Booth 14" link to the exhibitor at booth 14."

Source: client/src/areas/network/admin-vendors.tsx, client/src/areas/network/admin-packages.tsx, client/src/areas/network/vendor-payments.tsx, client/src/areas/agreements/VendorAgreementBits.tsx

### Attendees

`/admin/e/<id>/attendees`. Title **Attendees**. Buttons: **Import**, **Export**, **Add attendee**. Number strip: **Registered**, **Checked in**, **Unpaid**, **Sponsor passes**. A search box "Search by name or email".

Folder tabs: **All**, **Checked in**, **Not checked in**, **Unpaid**, **Speakers**, **Sponsors and exhibitors**, **Evaluations due** (each with a count).

Columns: **Name** (email, or a red **Cancelled** pill), **Type**, **Ticket**, **Payment** (Paid online, Paid by check, Sponsor pass, Complimentary, No charge, Unpaid, link sent, Refunded), **Check-in**, **Sessions**, **CE**, and **Details**.

An open row (**Editing attendee**): **Reprint badge**, red **Cancel** (asks first; they lose app access) or **Restore**; fields **First name**, **Last name**, **Credentials**, **City**, **Email**, **Mobile**, **Ticket**, **Badge type** (Attendee, Speaker, Exhibitor staff, Staff, Guest, Volunteer, Sponsor guest), **Organization**, **Job title**, **License number**, **License state**; **Save**, **Cancel**. Below: **Session check-ins** (each with **Remove**) and an **Add a session check-in** picker with **Add**.

**Add attendee** opens a side panel **Add attendee**: **Person** (**First name**, **Last name**, **Email**, **Mobile**, **Credentials**, **Type**: Attendee, Speaker, Sponsor guest, Exhibitor staff, Volunteer, Guest), for Sponsor guest and Exhibitor staff a **Sponsor** or **Exhibitor** picker, **Ticket and payment** (**Ticket**, then **Sponsor pass** or **Booth staff pass**, **Complimentary**, **Paid outside the app** with Amount, How paid, Paid on, Check or invoice number, or **Send a payment link**), **After adding**: **Send the welcome email with the app link**. Buttons **Add**, **Add another**, **Cancel**.

**Import** opens **Import attendees**: a CSV with name, email, ticket name, credentials, phone; **Choose file** or paste rows; **Import** and **Cancel** (then **Done**). People already on the list are skipped.

Source: client/src/areas/ce/AdminAttendees.tsx, client/src/areas/network/AddAttendeeSheet.tsx

### Check-in desk

`/admin/e/<id>/checkin`. Title **Check-in desk**. Buttons: **Scan with camera** (only on devices that can scan; becomes **Camera off**) and **Add walk-in**. Number strip: **Checked in**, **Not yet**, **Walk-ins**.

A big search box "Scan a code or type a name" (a USB scanner or typing works; Enter looks up a badge code). Results need 2 or more letters; each shows name, city and type, a pill (**Checked in**, **Not checked in**, **Cancelled**) and **Select** (becomes **Selected**).

The **Badge** card shows the badge preview and size, then: **Check in and print** (or **Reprint badge** once checked in), **Check in only**, **Edit badge name** (First name, Last name, Credentials with **Save** and **Cancel**), and **Undo check-in**. It notes "Checked in <time> by <name> · Badge printed once". Printing opens a pop-up window with the badge that prints itself (allow pop-ups).

**Add walk-in**: **First name**, **Last name**, **Email**, **Mobile**, **Credentials**, **City**, **Ticket**, "No payment is taken. They are checked in right away.", **Add**, **Cancel**.

Source: client/src/areas/ce/CheckInDesk.tsx

### Staff roles

`/admin/e/<id>/staff`. Title **Staff roles**. Button **Add role** (makes "New role" and opens it). The Check-in volunteer row starts open.

Columns: **Role**, **Can see**, **People**, **Details**. An open role (**Editing role**): **Role name**, **Access ends** (When the event ends, Never), **Sign in with** (Email code, Text code), **What this role can open** with one picker per area (Check-in desk, Attendees, Sessions, Help, Proposals, Vendors, Registration, Reports, Speakers, Community, Announcements, Evaluations, Certificates), each **Edit**, **View** or **No access**. **People in this role** with **Remove**, an email box "Add a person by email", **Pick their vendor** (Booth staff only) and **Add** (emails them a sign-in link). **Save**, **Cancel**, and **Delete** for roles you made.

Source: client/src/areas/ce/AdminStaffRoles.tsx

### Evaluations

`/admin/e/<id>/evaluations`. Title **Evaluations**. Button **Add form**. Columns: **Form** (with a **Default** pill), **Questions**, **Sessions**, **Responses**, **Details**. An open form shows **Questions** with **Export**, **Edit**, **Delete** (only with no responses), each question with its answer type, Required or Optional and its result; **Opens**, **Closes**, **Needed for certificate**; **Results by session** and **Latest comments**.

**Edit** opens `/evaluations/<id>` (**Editing form**): **Form name**, **Default for CE sessions**, each question with **Answer type** (Rating 1 to 5, Yes or no, Multiple choice, Comment), **Required** or **Optional**, **Remove**, choices for multiple choice, **Add question**; **Opens** (When the session ends, At check-in), **Closes** (14 days after the session, 30 days after the session, Never), **Needed for certificate**; **Sessions that use this form** checklist; **Save**, **Cancel**. When responses exist, an amber banner warns that changes affect reporting.

Source: client/src/areas/ce/AdminEvaluations.tsx

### Certificates

`/admin/e/<id>/certificates`. Title **Certificates**. Buttons: **Issue certificate**, **Export CE records**. Card **Certificate template: <name>** with **Edit** (CE provider, Provider number, Approval statement, Signed by, Issued when, One certificate per, Minimum time in the room), **Other templates** and **Add template**. A **Preview** of the certificate. Then **Issued (N)** with a search "Search by name, session or ID" and columns **Attendee**, **Session**, **Issued**, **CE**, then **View**, **Resend**, **Revoke** (or **Restore**).

**Issue certificate** box: **Find attendee**, **Attendee**, **For** (The whole event, or a session), **CE hours**, "We email the certificate to them right away.", **Issue**, **Cancel**.

Template editor (`/certificates/<id>`, **Editing certificate template**): **Template name**, **Certificate title**, **CE provider**, **Provider number**, **Approval statement**, **Signer name**, **Signer title**, **Signature** (Typed in script, Uploaded image), **Issued when** (Checked in and evaluation submitted, Checked in), **One certificate per** (Session, Event (all sessions together)), **Minimum minutes in the room**, **Issue certificates with this template**, **Show on certificate** (Credentials, Session title, Session date, CE hours, Certificate ID, Presenter name); **Save**, **Cancel**, **Delete** (not the default).

Source: client/src/areas/ce/AdminCertificates.tsx

### Announcements

`/admin/e/<id>/announcements`. Title **New announcement** for people who can send (else **Announcements**). The editor: **Title**, **Send to** (Everyone, Checked in, Not checked in yet, Speakers, Exhibitors, One ticket type, People in a session, each with a count), **Message**, **Session** or **Ticket type** when needed, **Send by** (**Push**, **Email**), **When** (Now, Schedule for later, with **Send at**), **Link (optional)**. Buttons **Send** (or **Schedule**) and **Save draft**.

Lists: **Scheduled and drafts** (Announcement, Send to, Status, with **Edit** that also offers **Delete**) and **Sent** (Announcement, Sent to, Sent, Opened, with **View**). Every sent announcement also appears as an in-app alert.

Source: client/src/areas/program/adminInfo.tsx

### Community (admin)

`/admin/e/<id>/community`. Title **Community**. Button **New topic** (box: **Name**, **Description**, **Category**, **Pin to the top**, **Add**, **Cancel**). Cards: **Reported posts** (Post, Topic, Reports, **Remove**, **Keep**), **Topics** (Topic, Posts, Status pill, **Pin**/**Unpin**, **Lock**/**Unlock**, **Details**), and **Community rules** with **Edit** (**Who can start topics**: All attendees, Event team only; **Exhibitors can post**: Only in their own topic, Anywhere, Not at all; **Hide a post after**: 3, 5, 10 reports or Never). An open topic has a **Topic** section with **Archive** (or **Restore**) and **Edit**, **Post as the event team** with **Post**, and **Posts** each with **Hide** or **Show**.

Source: client/src/areas/network/admin-community.tsx

### Photos (admin)

`/admin/e/<id>/photos`. Title **Photos**. Buttons **Download all** and **Add photos**. Number strip **Posted**, **Waiting for review**, **Hidden**, **Likes**. **Photo settings** with **Edit**: **Photos in the app** (On, Off), **New photos** (Post right away, Event team reviews first), **Who can post** (Everyone at the event, Attendees only, Staff only). Folder tabs **Waiting for review**, **Posted**, **Hidden**. Each photo card has **Post**, **Hide** or **Delete** depending on the tab; clicking the photo opens it large.

Source: client/src/areas/network/admin-photos.tsx

### Help (admin)

`/admin/e/<id>/help`. Folder tabs **Articles**, **Requests** (with the open count), **Lost and found**.
- Articles: **Help desk** section with **Edit** (**Where**, **Hours**, **Phone**, **Lost and found note**), **Common questions** with **Add question** and each question's **Edit** (**Question**, **Category**, **Answer**, **Order**, **Save**, **Cancel**, **Delete**).
- Requests: columns **Attendee**, **Message**, **Sent**, **Status** (Open, Answered, Resolved), with **Reply** or **View**. Open: the details, a **Reply** box ("The attendee gets an alert in the app."), **Send reply**, **Resolve** (or **Reopen**).
- Lost and found: **Log found item**; columns **Kind**, **Item**, **Where**, **Owner**, **Status** with **Mark found**, **Picked up**, **Reopen** or **Edit**. Item editor: **Item**, **Kind of item**, **Where it was found**, **Notes (staff only)**, **Add photo**, **Save**, **Cancel**, **Picked up**, **Delete**.

Source: client/src/areas/program/adminInfo.tsx

### Dining (admin)

`/admin/e/<id>/dining`. Cards **Event menu** (**Add meal**; columns Date, Meal, Time, Location, Items, **Edit**) and **Near the venue** (**Add place**; columns Place, Type, Price, Walk, Attendee offer, **Edit**). Meal editor: **Date**, **Meal**, **Location**, **Start**, **End**, **Note**, menu items with **Dietary label** and **Remove**, **Add item**, **Save**, **Cancel**, **Delete**. Place editor: **Name**, **Type** (Other, Quick bite, Sit-down, Coffee), **Cuisine**, **Price**, **Walk (minutes)**, **Attendee offer**, **Address**, **Phone**, **Website**, **Order**, **Short description**.

Source: client/src/areas/program/adminInfo.tsx

### About host (admin)

`/admin/e/<id>/host`. **About your host** section with **Edit**: host logo **Upload**/**Replace**/**Remove**, **Host name**, **Join or renew button opens** (Host website, Another link, Hide the button) and **Join link**, **About**, **Mission**, **Website**, **Email**, **Phone**, **Instagram**, **Facebook**, **LinkedIn**. Then **Team members (N)** with **Add person**; columns Name, Title, Shows under, **Remove**, **Edit**. Person editor: photo **Upload**/**Change**, **Name**, **Title**, **Shows under** (Our team, Board of directors, Advisory board, Staff, Volunteers, Other (type your own)), **Workplace (optional)**, **Order in the group**, **Bio**, **Save**, **Cancel**.

Source: client/src/areas/program/adminInfo.tsx

### Branding

`/admin/e/<id>/branding`. One card with four sections on the left and a **Preview** on the right (switch **App**, **Checkout**, **Email**, plus a **Badge preview**).
- **App look** with **Edit**: **Start from a theme** (Forest, Ocean, Plum, Crimson, Charcoal, Royal) and **Match my logo**, **Main color**, **Button color**, **Highlight color**, **Button text** (Automatic, White, Dark), **Page background** (Light gray, White), **Text size** (Standard, Larger), a contrast check banner, **Header** (Solid color, Cover image, White with logo), **Button shape** (Rounded, Square, Pill), **Font** (Plus Jakarta Sans, Inter, Lora, Montserrat).
- **Name, logo and icon** with **Edit**: **App name**, **App address** (read-only), **Logo**, **App icon**, **Cover** (each **Upload**/**Replace**/**Remove**).
- **In the app** with **Edit**: checkboxes **Attendee messaging**, **People directory**, **Meeting requests**, **Community**, **Live polls and Q&A**, **Exhibitors and sponsors**, **Food and dining**, **Photos**.
- **Badge** with **Edit**: **Badge size** (4 x 3 in, 4 x 6 in), **Name style** (First name large, Full name), **Show on badge** (Credentials, City and state, Organization, QR code, Attendee type band), and **Band color by attendee type** (Attendee, Speaker, Exhibitor, Staff).

Saving says "Branding saved".

Source: client/src/areas/program/adminInfo.tsx

### Agreements

`/admin/e/<id>/agreements`. Title **Agreements**. Button **New agreement** (opens a side panel **Start from a template**: Sponsor agreement, Exhibitor agreement, Speaker agreement, Blank, each with **Use**; "Have your attorney review your agreement before you use it."). Columns: **Agreement**, **Used on**, **Signed** ("N of M signed" or "None sent yet"), **Last edited**, **Open**.

An open agreement shows **Agreement** (the text, with fields as green chips) with **Edit**, and **Signing** (When they sign or Send to sign, Reminders, the organization's values, Organization signer, Countersign, Signed copy).

**Edit agreement**: **Name**, **Used for** (Sponsors, Exhibitors, Speakers), the text editor, **Insert a field** chips (for example Company name, Package name, Session title), value fields such as **Cancel by date**, **Cancel fee**, **Setup time**, **Teardown time**, **Speaker benefits**, **Materials due date**; for sponsors and exhibitors **When they sign** (**On the checkout page**: "Before paying. Recommended." or **By email after paying**); for speakers **When a proposal is accepted** and **When a speaker is added by hand**; **Reminders** (Off, Every 2 days, up to 3; Every 3 days, up to 3; Every 7 days, up to 2), **Organization signer**, **Title**, **Ask for recording permission (Yes or No)** (speakers), **Countersign automatically**. Buttons **Save**, **Cancel**, **Delete**, **Preview** (opens **Preview with sample details**).

Source: client/src/areas/agreements/AdminAgreements.tsx, client/src/areas/agreements/AgreementsTab.tsx

### Reports

`/admin/e/<id>/reports`. Title **Reports**. Button **Export all**. Number strip **Registered**, **Checked in** (with % of registered), **Opened the app**, **CE hours issued** (with certificates). Cards: **Sessions** (Session, Checked in, Of those scheduled, Of capacity, Eval score) with **Export**; **Registrations by ticket** with **Export**; **Registrations by day**; **Vendors** (leads per company); **Engagement** (Community posts, Messages sent, Meetings booked).

Source: client/src/areas/ce/AdminReports.tsx

### Event settings

`/admin/e/<id>/settings`. Title **Event settings**.
- **Event** section with **Edit**: Name, Short name, Dates, Time zone, Capacity, Status ("Draft (attendees cannot open the app yet)", Live, Ended), Attendee app link. Edit: **Name**, **Short name**, **Starts**, **Ends**, **Time zone**, **Capacity**, **Status** (Draft, Live, Ended).
- **Location** section with **Edit**: Venue, Address, In the app, a map preview and **Open in Google Maps**. Edit: **Venue or hotel name**, **Street address**, **Suite, building or floor (optional)**, **City**, **State**, **ZIP code**, with a live map.

After the event's last day, an amber banner says "This event ended on <date>, so its dates are locked..." and the dates show a lock.

Source: client/src/core/screens.tsx

### Attendee app: welcome and sign-in

`/e/<slug>`. Cover with the event logo, "<organization> presents", the event name, dates and place. The card: **Welcome! Sign in to the app**, **Email** (placeholder "you@example.com"), **Email me a code**, "Tip: add the app to your home screen for session reminders." Then **Check your email**, six code boxes, **Sign in**, **Use a different email**, **Send a new code**. Below: Your agenda, CE credits, Meet people, Photos; "Thank you to our sponsors" logos; "Not registered yet?" with **Register for <short name>**.

If the email has no registration: **We could not find your registration**, **Register now**, **Try a different email**. If the event is in Draft: **The app opens soon** (event staff still get in).

Source: client/src/core/EventWelcome.tsx, client/src/areas/program/attendee.tsx, client/src/shells/AttendeeShell.tsx

### Attendee app: Home

`/e/<slug>/home`. A cover with "Hosted by <organization>", the name, dates and "Day N" during the event. **Up next for you · <time>** with **Check in** or **View**. Up to eight round shortcuts (Agenda, My agenda, Speakers, Sponsors, Exhibitors, Photos, CE credits, Dining, Venue map, Nearby, About host). **Your pass** with the person's name, **My badge**, **Edit profile** and **My events (N)** (when they have more than one). Event staff who are not registered see **Signed in** with **Event admin** and **Sign out**. **Where**: venue, address, map, **Directions** and **Venue map**. **More** list: Alerts, CE credits, Dining, Nearby, About host, Help, Lost and found, Speaker page (speakers), Scan leads (booth staff), Sign out (only items not already shortcuts). A rotating sponsor banner at the bottom opens the sponsor's details.

Source: client/src/areas/program/home.tsx

### Attendee app: Agenda and My agenda

Agenda (`/agenda`): header with the logo, dates, name, an **Alerts** bell and a **My badge** QR button; switch **Full agenda** / **My agenda**; one button per day. Chips **All sessions**, **CE eligible**, **Tracks** (then a track picker "Every track"), and a search button ("Search sessions, speakers or rooms"). Sessions grouped by start time, each with speaker photos, time, room, speakers, pills (CE, track, "N seats left" or **Full**) and a **+** button (adds to My agenda) or a check mark (already added). Adding a session that overlaps says "Added. This overlaps with <title> at <time>."

My agenda (`/my`): **My agenda** with counts **Sessions**, **Attended**, **CE earned**; sessions by day with a status pill (CE issued, Attended, Upcoming, Ended), an overlap warning, **Take evaluation** and **Check in** buttons. Empty: "Nothing on My agenda yet." with **Browse the agenda**.

Source: client/src/areas/program/attendee.tsx

### Attendee app: Session

`/session/<id>`. Back bar **Session**. Pills, title, date and time, room, description, **Slides and handouts** (with **Download**, once sharing allows), each speaker with **Bio** (opens a pop-out with a large photo, the bio, and **Message** and **Website** when available), **Earning CE for this session** (three steps: Scan the QR code at the door to check in; Take the evaluation after the session; Get your certificate in CE credits), **Live poll and Q&A**, and **Remind me 15 minutes before** (when on My agenda). Footer: **Add to agenda** (or **Sign up**, **Full**, **On my schedule**, which removes it when tapped) and **Check in** (or **Checked in**, **Take evaluation**). Tapping **Check in** early says "Check-in opens 30 minutes before <time>."

Source: client/src/areas/program/attendee.tsx

### Attendee app: Speakers

`/speakers`. Search "Search speakers or topics"; a grid of speaker cards (photo, name, title, "N sessions"). Tapping one opens the bio pop-out.

Source: client/src/areas/program/attendee.tsx, client/src/areas/program/shared.tsx

### Attendee app: Check in, Evaluation, CE credits, CE transcript, My badge

- Check in (`/checkin/<sessionId>`): "Scan the code posted at the door" with the camera; **Type the room code instead** shows **Room code** and **Check in**. Scanning a door QR checks in right away. Success: **You are checked in** with the time; then **Take evaluation**, or "The evaluation opens at <time> when the session ends...", or "Your evaluation is in. See your CE credits". The window: from 30 minutes before the start to 15 minutes after the end.
- Evaluation (`/eval/<sessionId>`): "1 = Strongly disagree, 5 = Strongly agree"; rating buttons 1 to 5, Yes or No, choices, comment boxes; footer **Submit and get certificate** (CE sessions) or **Submit**. Not open yet: messages such as "Check in to this session first..." with **Check in**.
- CE credits (`/credits`): switch **This event** / **All years**; "CE hours earned" with **Download all**; **Certificates** cards with **Issued**, **View** and **Download**; **Waiting on you** cards with **Evaluation due** and **Take evaluation**.
- CE transcript (`/transcript`): "CE hours with this host", **Download transcript**, **Print**, one row per event.
- My badge (`/badge`): the event bar, a large QR code, the name and city, a "Checked in at..." pill, and "Show this code at the registration desk to get your badge."

Source: client/src/areas/ce/AttendeeScreens.tsx

### Attendee app: Alerts and More

- Alerts (`/alerts`): **Push notifications** switches (Session reminders, Evaluation ready, Room and time changes, Announcements from <organization>), a **Notifications** row with **Turn on**, and alerts grouped by day. Opening the page marks them read.
- More (`/more`): rows CE credits, CE transcript, People, Speakers, Your speaker page, Exhibitors and sponsors, Photos, Venue map, Food and dining, Help center, Lost and found, About your host, My badge, My profile, Scan leads, Alerts; and **Notifications**. No button links here; open it by address.

Source: client/src/areas/program/info.tsx, client/src/ui/PushToggle.tsx

### Attendee app: People, profiles, meetings

- People (`/people`): search "Search by name, city or specialty"; chips **Everyone**, **Speakers**, **Exhibitors**, **In my sessions**; **Any interest** and **Any organization** pickers; each person with **Message**; the switch "Show me in People so others can message me"; **Edit my profile**.
- A profile (`/people/<id>`): photo, name, **Message**, **Request meeting**, About, Interests, "Sessions you both picked", and a "..." menu with **Block** or **Unblock**.
- My profile (`/profile`): **Profile** section with **Edit** (**Add photo**, **Credentials**, **Job title**, **Organization**, **City**, **Interests**, **About**, "Show me in People so others can message me"), **People you blocked** with **Unblock**, and **Sign out**.
- Request a meeting (`/meet/<id>`): day chips, "Times you are both free" buttons, **Length** (15, 30, 45, 60 minutes), **Where** (map pins, or **Somewhere else**), **Note (optional)**, **Send request**.

Source: client/src/areas/network/people.tsx

### Attendee app: Messages

`/messages`: header with a **+** (New message, opens People); **Meetings** cards (**Accept**, **Decline**, **Cancel request**, **Cancel meeting**); conversations; "Messages stay between attendees. The event team does not see them." A conversation (`/messages/<id>`): bubbles, a "Write a message" box with a **Send** arrow, and a "..." menu with **Mute**/**Unmute** and **Block**.

Source: client/src/areas/network/messages.tsx

### Attendee app: Community

`/community`: **People** button, **Start a discussion**, switch **All topics** / **Joined**, topics with **Join**, **Joined** or **Pinned**. A topic: **Join**/**Joined**, posts with likes, **Reply**, "..." with **Report post**, and a "Write a post" box. Start a discussion: **Topic title**, **First post**, **Category** chips, **Post**.

Source: client/src/areas/network/community.tsx

### Attendee app: Exhibitors and sponsors, Venue map, Scan leads

- Exhibitors and sponsors (`/exhibitors`): switch **All**, **Sponsors**, **Exhibitors**; sponsors by level and an **Exhibitors** list, each with **Message**. Tapping opens a pop-out with the logo, level, offer, about, **Message**, **Find booth**, **Visit website**.
- Venue map (`/map`): level tabs, the map with pins, "Find a room or booth", matches, and **See <company>**.
- Scan leads (`/leads`, booth staff and staff with vendor edit access): **Booth** picker (when more than one), the camera ("Point at the QR code on a badge"), "Or type the badge code" with **Look up**, the found person with **Interest** (Hot, Warm, Cold), **Note**, **Cancel**, **Save lead**; **Export my leads** and the lead list.

Source: client/src/areas/network/booths.tsx

### Attendee app: Live poll and Q&A

`/poll/<sessionId>`: the session and "Live now"; poll cards (vote buttons, then results with "(your vote)"); **Questions for the speaker** with upvote buttons; the box "Ask the speaker a question" with **Ask without my name**. Presenters (speakers on the session, event admins and staff who can edit sessions) also see **New poll** (**Question**, answers, **Add answer**, **Save for later**, **Open now**), **Open**/**Close**/**Reopen**, **Delete**, and **Answered**/**Hide** on questions.

Source: client/src/areas/network/poll.tsx

### Attendee app: Photos

`/photos`: **Add photos** (when allowed), switch **All photos** / **My photos**, a grid ("Waiting for review" on pending ones), **Show more**. **Add photos** picks up to 20 images, then **Caption (optional)**, **Session (optional)**, and **Post 1 photo** (or **Post N photos**). A photo opens full screen with **Like**, **Download**, and **Delete** (yours) or **Report**.

Source: client/src/areas/network/photos.tsx

### Attendee app: Food and dining, About your host, Help center, Lost and found

- Food and dining (`/dining`, `/nearby`): switch **Event menu** / **Near the venue**; day chips and meals; place chips (All, Quick bite, Sit-down, Coffee) with **Directions** and **Call** or **Website**.
- About your host (`/host`): logo, name, **Join or renew**, **Website**, About, Mission, contacts, team members by heading (tap for a bio pop-out).
- Help center (`/help`): **Help desk** with **Message us** and **Call**, a **Lost and found** link, **My requests**, **Common questions** (search when more than four). **Message us** opens **Message the help desk** with **Topic**, **Message**, **Send**.
- Lost and found (`/lost-found`): **Report a lost item** (chips Phone, Keys, Wallet, Bag, Clothing, Other; **Describe it**; **Where you last had it**; **Send report**), **My reports**, **Turned in at the help desk**.

Source: client/src/areas/program/info.tsx

### Public: attendee checkout page

`/r/<slug>`. Left: cover, logo, headline, dates, place, description. Right: **Who is registering?** chips (when buyer choices exist; "Pick one to see your tickets and prices."), or **Pick your ticket**. An early bird banner "Early bird pricing ends <date>. N days left to save." Ticket cards with price (crossed-out regular price and "Early bird · save $X" when early), a price-by-date line, **Details**, "N left", **Select**/**Selected**. **Have a discount code?** then **Apply**. A bottom bar with the total and **Continue** (or the custom button label). "Registration is closed." or "Tickets are not on sale yet." when that applies.

- Register (`/r/<slug>/register`): steps Ticket, Details, Payment; **Your ticket** with **Change**; **Your details** (**First name**, **Last name**, **Email**, **Member ID**, **School**, the event's questions, "Text me the app link and event updates. Reply STOP to opt out."). Footer **Total** and **Register** (free) or **Continue to payment**.
- Pay (`/r/<slug>/pay`): the ticket, **Coupon code** with **Apply**, **Total**, and Stripe's payment form. "This event is not taking payments yet." when Stripe is not ready.
- Done (`/r/<slug>/done`): **You're registered, <name>**, the welcome email note, **Get the conference app** with **Install the app** and iPhone steps, **Add to calendar**.

Source: client/src/areas/registration/public.tsx

### Public: Get the app and embed

- Get the app (`/get/<slug>`): **Get the <event> app**, **Install the app**, iPhone steps (Tap the Share button in Safari; Tap Add to Home Screen; Leave Open as Web App on, then tap Add), **Open the app**, and a QR code "On a computer?".
- Embed (`/embed/<slug>`): a compact **Register for <short name>** form used inside other websites.

Source: client/src/areas/registration/public.tsx

### Public: sponsor and exhibitor checkout

`/r/<slug>/sponsor` and `/r/<slug>/exhibit`. Steps: **Package** (or **Booth**), **Company**, **Agreement** (only when an agreement is set), **Payment**.
1. Package cards with price, "N left" and what is included; **Continue**.
2. **Company**: **Company name**, **Website**, **First name**, **Last name**, **Email**, **Mobile** (sponsors) or **Category** (exhibitors); **Logo** with **Upload**; **About your company** (sponsors) or **Booth offer shown in the app (optional)**; **Event passes (N included)** or **Booth staff (N included)** names and emails; **Add-ons** with plus and minus buttons; **Booth request (optional)** (exhibitors); **Back**; **Total**; **Continue**.
3. **Sponsor agreement** (or Exhibitor): the agreement, **Read full agreement**, **Download PDF**, **Sign** with **Full name**, **Title**, a signature preview, "I have read this agreement and I am signing it for my company.", **Sign and continue**, **Back**.
4. **Summary**, **How to pay** (**Pay in full**, **Pay a deposit**, **Pay by invoice**), then **Pay $X** or **Request invoice**.

Closed page: "This page is not open yet." Done page: "You are a <package> sponsor" (or "Your <booth> is booked"), **Next steps** (**Add names**, **View** the app listing, **Download** the agreement). Pay link page (`/pay?v=`): the company, what is owed, **Pay $X** or **Pay now instead**, **Change payment method**.

Source: client/src/areas/registration/vendorPublic.tsx, client/src/areas/agreements/SignAgreement.tsx

### Public: sign an agreement and the signed copy

- `/sign/<code>`: **Sign your <sponsor, exhibitor or speaker> agreement**, a summary (Session, When, Room for speakers), the agreement, **Read full agreement**, **Download PDF**, **May we record your session?** (Yes, No; speakers when asked), **Sign** (**Full name**, **Credentials** for speakers or **Title**), "I have read this agreement and I agree to it.", **Sign agreement**. After: **Thank you for signing** with **View signed copy**.
- `/agreement/<code>`: the copy laid out like the PDF with signatures, **Sign now** (if not signed) and **Download PDF**.

Source: client/src/areas/agreements/public.tsx, client/src/areas/agreements/SignAgreement.tsx

### Public: speaker page

`/speak/<token>`. **Your speaker page**, the event and dates; for each session the Session, When, Room and co-presenters; **Slides and handouts** (**Upload your slides**, "PowerPoint, Keynote exported to PDF, or PDF. Up to 100 MB each.", **Choose files**; once files exist **Add a file**, **Replace**, **Remove**; **Share with attendees**: After my session starts, Right away, Do not share); **Bio and photo** with **Edit** (**Upload photo**, **Credentials**, **Job title**, **Organization**, **Bio**, **Save**, **Cancel**); **Speaker agreement** with **Sign now** or **View PDF**; **Your registration** with **Get the app**. Speakers reach it from their emails, or from **Speaker page** in the app when their speaker email matches their sign-in email.

Source: client/src/areas/program/speakerPage.tsx

### Public: call for proposals

`/cfp/<slug>`. Header **Call for proposals** with the event and "Due <date>"; the guidelines. Sign-in first (**Sign in to submit**, **Email**, **Email me a code**, then **Code**, **Sign in**). Then **Your proposals** with status pills, and the form: **Session title**, **Format**, **Track**, **Abstract**, **Learning objectives** (three boxes), **Request CE credit for this session**, the event's questions, **Presenters** (**Your name**, **Credentials**, **Organization**, **Short bio**, **Add headshot**, **Add presenter**), **Save draft** (saves on this device only) and **Submit**. After: **Thank you** with **Submit another**.

Source: client/src/areas/network/cfp.tsx

### Public: certificate

`/cert/<code>`. A green banner "Verified. Issued to <name> by <provider> on <date>." with **Download** (prints), the certificate, and "Anyone can check this certificate at...". A revoked one shows a red banner.

Source: client/src/areas/ce/CertificatePage.tsx

## Tasks

All tasks assume the demo organization and demo event from "Where and how". Names and emails in examples are made up; use team-controlled inboxes for any email field.

### Organization owner

### Sign in to the admin
- For: Organization owner
- Starts on: https://events.leaddash.io/admin (the admin sign-in page)
- Needs in the demo: an email on the demo organization's Admin team, and access to its inbox
- Steps:
  1. Click in **Email** and type the email. Click **Email me a code**. The card changes to **Check your email**.
  2. Open the inbox, find "Your sign-in code: ######", and copy the six digits.
  3. Paste them into the first box. All six boxes fill.
  4. Click **Sign in**. The **Events** page opens with the organization's events.
- Done when: the sidebar shows the LeadDash Events logo, **Find a page**, and the organization pages.
- Watch out: Do not show the code or the inbox on video. If you see "Your email is not on an organization's admin team yet", the email is not on a team. Never request more than 3 codes a minute.

### Create a demo event and its dates
- For: Organization owner
- Starts on: Events (`/admin`)
- Needs in the demo: a demo organization with an unused event allowance
- Steps:
  1. Click **New event**. The **New event** box opens.
  2. Type **Event name** (for example "Demo Annual Conference") and **Short name (app header)** (for example "Demo Conference 2027").
  3. Pick **Time zone**.
  4. Pick **Starts** and **Ends** dates.
  5. Fill **Venue or hotel name**, **Street address**, **City**, **State**, **ZIP code**.
  6. Click **Create**. The new event's **Event home** opens with the **Getting ready** card.
- Done when: the event is on **Events** with a **Draft** pill, and the sidebar event card shows its name and dates.
- Watch out: If **Your account includes 1 event** appears, the organization has used its allowance; only LeadDash staff can raise it. Events cannot be deleted. Never create a test event in a customer organization. "The end date is before the start date." means the dates are reversed.

### Set the organization's look and admin team
- For: Organization owner
- Starts on: Organization settings (`/admin/settings`)
- Needs in the demo: a logo image file with a generic design
- Steps:
  1. In **Organization**, click **Edit**. An orange **Editing** pill shows.
  2. Change **Main color**, **Button color**, and **Highlight color** (or click **Same as main**).
  3. Under **Logo**, click **Upload** and pick the image.
  4. Leave **Use these colors and logo on every event** unchecked unless you want every event changed.
  5. Click **Save**. A toast says "Saved" (or how many events use the new look).
  6. In **Admin team**, type a **Name** and **Email** (a team inbox) and click **Add**. A toast says "Added. They sign in with their email."
- Done when: the read view shows the new colors and logo, and the new person is listed with an **Admin** pill.
- Watch out: **Make owner** and **Transfer ownership** hand the whole organization to someone else; do not click them in a demo. **Remove** takes a person off the team.

### Brand the event app
- For: Organization owner
- Starts on: Branding (Setup group)
- Needs in the demo: a logo, a square app icon and a wide cover photo with no real people or customer names
- Steps:
  1. In **App look**, click **Edit**. Click a theme under **Start from a theme** (for example **Ocean**), or upload the logo first and click **Match my logo**. The **Preview** on the right changes as you pick.
  2. Pick **Header**, **Button shape** and **Font**. Check that the banner says "Easy to read...". Click **Save**. A toast says "Branding saved".
  3. In **Name, logo and icon**, click **Edit**, type **App name**, click **Upload** under **Logo**, **App icon** and **Cover**, then **Save**.
  4. In **In the app**, click **Edit**, check the features to show (for example **Photos** and **Live polls and Q&A**), then **Save**.
  5. In **Badge**, click **Edit**, pick **Badge size** and **Name style**, check **Attendee type band**, set band colors, then **Save**. Watch the **Badge preview**.
  6. Switch the preview to **Checkout** and **Email** to show the same look there.
- Done when: the read views show the new values and the preview matches.
- Watch out: Turning a feature off in **In the app** also hides its admin page (for example Community or Photos). The LeadDash Events logo stays in the admin; the event's logo shows only on attendee-facing pages.

### Show the Stripe payments setup
- For: Organization owner
- Starts on: Payments (`/admin/payments`)
- Needs in the demo: nothing
- Steps:
  1. Open **Payments** in the sidebar. The banner shows the Stripe state.
  2. If not connected, point out **Get paid with Stripe** and its three steps, and the **Connect with Stripe** button. Do not click it unless Ashley confirms the demo uses a Stripe test account.
  3. If connected, show **Stripe account** (Status, Payouts to, Klarna, Afterpay, Refunds, LeadDash fee) and **Where the money goes**.
- Done when: the viewer has seen where payments are connected.
- Watch out: Never click **Disconnect**, **Refund**, or **Connect with Stripe** on a real organization. Payments go straight to the organization's own Stripe account.

### Open the app to attendees and set the venue
- For: Organization owner
- Starts on: Event settings (Setup group)
- Needs in the demo: the demo event
- Steps:
  1. In **Event**, click **Edit**.
  2. Check **Starts** and **Ends**, type a **Capacity** if wanted.
  3. Change **Status** from **Draft** to **Live**. Click **Save**.
  4. In **Location**, click **Edit**, fill the address fields, and watch the map update. Click **Save**.
- Done when: **Status** reads Live, and **Event home** no longer lists "Open the app to attendees".
- Watch out: While Draft, attendees see **The app opens soon**; staff can still open the app. Never pick **Ended** on a live event. After the last day, dates and status lock.

### Event staff

### Add a ticket with early bird pricing
- For: Event staff
- Starts on: Tickets (Tickets and sales group)
- Needs in the demo: the demo event
- Steps:
  1. Click **Add ticket**. A **New ticket** editor opens in the list.
  2. Type **Ticket name** (for example "Full conference"), pick **Includes**, leave **How many** empty for no limit, and set **On sale** to **On**.
  3. In **Price by date**, check **Early bird**, type its price (for example 299.00) and pick its **Ends** date.
  4. Type the **Regular** price (for example 349.00).
  5. Read **What buyers see today**, which shows the crossed-out regular price and "Early bird · save $50.00".
  6. Click **Save**. A toast says "Ticket saved".
- Done when: the row shows the price today with an orange **Early bird** pill, and the number strip shows **Early bird ends**.
- Watch out: On the day after the early bird date the price moves to Regular by itself. A row marked **Off** does not show on the checkout page. **Delete** only appears while none are sold. For free-registration demos, also make a ticket priced 0.00.

### Set up member tickets with buyer choices
- For: Event staff
- Starts on: Tickets
- Needs in the demo: the default buyer choices (Member, Non-member, Student)
- Steps:
  1. In **Who is registering (buyer choices)**, click **Edit**. Check that **Member** has **Asks for a member ID** checked. Click **Save**.
  2. Open the default **Member** ticket with **Edit**.
  3. Under **Who can buy it**, check the **Member** chip. A price column named Member appears.
  4. Type the **Regular** price for members, set **On sale** to **On**, and click **Save**.
- Done when: the Member ticket row shows "Member" under **Who can buy**, and on the checkout page picking **Member** shows that ticket and asks for **Member ID**.
- Watch out: With no buyer choices, use **Who can buy it**: **Members only (asks for member ID)**. The organization checks member IDs in its own membership system; the app does not verify them. A **Code (optional)** keeps a choice to people given the code.

### Add a coupon
- For: Event staff
- Starts on: Tickets
- Needs in the demo: at least one paid ticket
- Steps:
  1. In **Coupons**, click **Add coupon**.
  2. Type **Code** (for example "DEMO10"), pick **Discount** **Percent off**, type **Percent** 10, set **Max uses** and **Ends**.
  3. Leave **Coupon is on** checked. Click **Save**. A toast says "Coupon saved".
- Done when: the row shows "10% off", "Used 0 of N" and the end date.
- Watch out: Buyers type the code under **Have a discount code?** on the checkout page.

### Set up the attendee checkout page and share it
- For: Event staff
- Starts on: Checkout page (Tickets and sales group), **Attendees** folder tab
- Needs in the demo: at least one ticket that is On
- Steps:
  1. In **Page**, click **Edit**.
  2. Under **Cover image**, click **Upload**. Type **Headline**, **Short description** and **Button label**.
  3. Set **Tickets on the page** to **All N ticket types** or **Pick ticket types**.
  4. In **Questions at sign-up**, uncheck **Required** where wanted, or click **Add question** and pick **Your own question**, type **Question text**, pick **Answer**, click **Add**.
  5. Under **After payment**, keep **Show the confirmation page with the Get the app button** and **Send the welcome email** checked. Leave **Add the person to the LeadDash platform with the tag** unchecked in the demo.
  6. Click **Save**. A toast says "Checkout page saved". The **Preview** updates.
  7. In **Share**, click **Copy** next to **Direct link**, or pick an embed style and click **Copy code**.
  8. Click **View checkout page** at the top to open it.
- Done when: the checkout page opens with the cover, headline and tickets.
- Watch out: Paid tickets need Stripe connected. "Pay over time" only shows Klarna and Afterpay when they are on in Stripe.

### Edit the welcome email and send yourself a test
- For: Event staff
- Starts on: Welcome emails (Tickets and sales group), **Attendees** folder tab
- Needs in the demo: nothing
- Steps:
  1. In **Welcome email**, click **Edit**.
  2. Change **Subject** and **Message**. Put the cursor in **Message**, then pick **App link** in **Insert a field**. The field text appears at the cursor.
  3. Under **Include in the email**, check what to include (for example **Check-in QR code**).
  4. Click **Save**. A toast says "Welcome email saved". The **Preview** shows the email.
  5. Click **Send me a test**. A toast says "Test sent to <your email>".
- Done when: the test email arrives in your inbox.
- Watch out: Tests always go only to the signed-in person. On the **Speakers**, **Sponsors** and **Exhibitors** tabs, **Send to new** emails real recipients; do not click it unless every recipient is a demo address.

### Add a session by hand and print its door QR
- For: Event staff
- Starts on: Sessions (Program group)
- Needs in the demo: the demo event
- Steps:
  1. Click **Add session**. A **New session** card opens.
  2. Type **Title**, pick **Kind**, **Date**, **Start**, **End**, type **Room**, **Track**, and **CE hours** (for example 1.5).
  3. For demos, set **Evaluation opens** to **At check-in**.
  4. Click **Save**. A toast says "Session added" and the new row opens.
  5. In the open row, click **Print door QR**. A print window opens with the QR and "Scan to check in for CE credit". Close it or print.
  6. Click **Attendance list** to show who has it on their agenda.
- Done when: the session is in the list with its CE hours, and its **Room code** shows in **Session details**.
- Watch out: Allow pop-ups to print. On the session's full page, **New code** stops printed QR codes from working. **Delete** removes the session from every agenda along with its check-ins.

### Import sessions from a CSV file
- For: Event staff
- Starts on: Sessions
- Needs in the demo: a CSV file with made-up sessions and speakers
- Steps:
  1. Click **Import**. **Import sessions** opens at **1. Choose a file**.
  2. Click **Download template** to get a sample file. Fill rows: Title, Date, Start time, End time, Room, Track, Type, CE hours, Speakers (separate names with semicolons), Description. Save it as CSV.
  3. Click **Choose file** and pick it (or drop it on the box). The box shows the file name and "Ready to check".
  4. Click **Next**. Step **2. Check the rows** shows counts and each row with **Ready**, **Already added** or **Needs a fix**.
  5. Click **Import N sessions**. A green banner says "N sessions added to the agenda".
  6. Click **Open Speakers** to see new speakers, or **Done**.
- Done when: the sessions appear on **Sessions** and new speakers on **Speakers**.
- Watch out: Nothing saves before the import button. Sessions with the same title, date and start time are skipped. **Back** returns to step 1. The template's sample uses a made-up name; replace it.

### Add a speaker and put them on a session
- For: Event staff
- Starts on: Speakers (Program group)
- Needs in the demo: a session, and a made-up headshot
- Steps:
  1. Click **Add speaker**. A **New speaker** card opens.
  2. Click **Upload headshot** and pick the image. Type **First name**, **Last name**, **Credentials**, **Title**, **Organization**, **City**, **Email** (a team inbox) and **Bio**. Check **Featured (shown first)** if wanted.
  3. Click **Save**. A toast says "Speaker added" and the row opens.
  4. In the **Speaker** card, click **Edit**. In **Sessions**, pick a session in **Add a session**. It joins the list right away.
  5. Click **Save**.
- Done when: the speaker row shows the session, and the attendee **Speakers** page shows the card.
- Watch out: You can also add speakers from the session (**Speakers**, **Edit**, **Add a speaker**). **Request update**, **Send welcome**, **Send** and **Send agreements** email the speaker; use team inboxes only.

### Track slides from speakers
- For: Event staff
- Starts on: Sessions, **Slides (N missing)** folder tab
- Needs in the demo: sessions with speakers
- Steps:
  1. Click the **Slides** folder tab. Rows show **Missing** or "1 file".
  2. Open a session's row on the **All** tab, then in **Slides and handouts** click **Edit**.
  3. Pick **Share with attendees** (for example **After the session starts**) and a **Due date for speakers**. Click **Upload file** to add a deck for the speaker.
  4. Click **Save**. A toast says "Slides settings saved".
- Done when: the Slides tab shows the file count and the sharing choice.
- Watch out: **Remind** and **Remind missing** email speakers. **Download all slides** downloads a zip.

### Send an announcement with push
- For: Event staff
- Starts on: Announcements (In the app group)
- Needs in the demo: demo attendees only; for push, a demo phone signed in to the app with notifications turned on
- Steps:
  1. Type **Title** and **Message**.
  2. In **Send to**, pick **Everyone** (the count shows in parentheses). Confirm the count matches your demo attendees.
  3. Under **Send by**, keep **Push** checked and uncheck **Email**.
  4. Set **When** to **Now** (or **Schedule for later** and pick **Send at**).
  5. Optional: type a **Link (optional)** such as `/e/<slug>/agenda`.
  6. Click **Send** (or **Schedule**). A toast says "Sent to N people" (or "Scheduled for...").
- Done when: the announcement is under **Sent** and appears in the app's **Alerts**.
- Watch out: Never send in an event with real attendees. **Save draft** keeps it under **Scheduled and drafts**.

### Add an attendee by hand
- For: Event staff
- Starts on: Attendees (People group)
- Needs in the demo: at least one ticket
- Steps:
  1. Click **Add attendee**. The **Add attendee** panel slides in.
  2. Type **First name**, **Last name**, **Email** (a team inbox, or Simone's own to use the app as an attendee), **Credentials**, and pick **Type** **Attendee**.
  3. Pick **Ticket**, then **Complimentary**.
  4. Leave **Send the welcome email with the app link** checked only if the email is a team inbox.
  5. Click **Add**. A toast says "<name> added".
- Done when: the person is on the list with **Complimentary** in **Payment**.
- Watch out: **Send a payment link** emails a checkout link and shows **Unpaid, link sent**. **Add another** keeps the panel open. **Cancel** in an open row cancels the registration; **Restore** brings it back.

### Check someone in at the check-in desk and print a badge
- For: Event staff (Check-in volunteer)
- Starts on: Check-in desk (People group)
- Needs in the demo: a demo attendee, and pop-ups allowed
- Steps:
  1. Click in the search box and type two or more letters of the name (or scan the QR on their **My badge** screen with **Scan with camera**).
  2. Click **Select** on the right person. The **Badge** card shows their badge.
  3. Optional: click **Edit badge name**, fix the name, click **Save**.
  4. Click **Check in and print**. A badge window opens and prints; a toast says "<name> checked in".
- Done when: the result shows a green **Checked in** pill and the number strip's **Checked in** count rises.
- Watch out: **Check in only** skips printing. **Undo check-in** asks first. **Add walk-in** checks someone in without payment.

### Add a session check-in by hand
- For: Event staff
- Starts on: Attendees
- Needs in the demo: a demo attendee and a session
- Steps:
  1. Click **Details** on the attendee. The row opens.
  2. Under **Session check-ins**, pick the session in **Add a session check-in**.
  3. Click **Add**. The session shows with "Added by staff".
- Done when: the row's **Sessions** count rises, and the attendee's app shows the session as attended.
- Watch out: Use this to demo evaluations and certificates without waiting for the session time. If the certificate rules are met, a certificate is issued and emailed to the attendee's email.

### Edit the session evaluation form
- For: Event staff
- Starts on: Evaluations (CE group)
- Needs in the demo: the default "Standard session evaluation"
- Steps:
  1. The only form opens by itself (or click **Details**). Click **Edit**. The **Editing form** view opens.
  2. Click **Add question**, type it, pick **Answer type** (for example **Yes or no**) and **Required**.
  3. Set **Opens**, **Closes** and **Needed for certificate**.
  4. Under **Sessions that use this form**, check sessions if needed.
  5. Click **Save**. A toast says "Saved" and the list returns.
- Done when: the form's **Questions** count shows the new number.
- Watch out: Changing questions on a form with responses changes how they are reported. **Delete** only appears with no responses.

### Set up the CE certificate and issue one by hand
- For: Event staff
- Starts on: Certificates (CE group)
- Needs in the demo: a demo attendee with a team inbox email
- Steps:
  1. On the template card, click **Edit**.
  2. Type **CE provider**, **Provider number** (made up), **Approval statement**, **Signer name**, **Signer title**. Pick **Signature** **Typed in script**.
  3. Pick **Issued when** and **One certificate per**. Check what to show under **Show on certificate**. Watch the **Preview**.
  4. Click **Save**. The page returns to **Certificates**.
  5. Click **Issue certificate**. Type in **Find attendee**, pick the **Attendee**, pick **For** (a session), check **CE hours**, click **Issue**. A toast says "Certificate issued and emailed".
  6. In **Issued**, click **View** to open the certificate page.
- Done when: the certificate is listed under **Issued** and its page says "Verified".
- Watch out: **Revoke** marks a certificate no longer valid. **Export CE records** downloads every record. Issuing always emails the attendee.

### Run a call for proposals and decide on one
- For: Event staff
- Starts on: Proposals (Program group)
- Needs in the demo: one proposal submitted from `/cfp/<slug>` with a team inbox; a Proposal reviewer optional
- Steps:
  1. In **Call settings**, click **Edit**. Set **Opens**, **Due date**, **Blind review**, type guidelines, **Formats** and **Tracks** (one per line). Click **Save**.
  2. Click **Copy proposal link** and open it in another tab to show the public form.
  3. Back on the list, click **Details** on a proposal. Read the abstract and reviews.
  4. Click **Decide**. In the **Decide** panel pick **Accept**, choose **Session time** and **Room**.
  5. Uncheck the email boxes unless the submitter is a team inbox.
  6. Click **Save**. A toast says "Decision saved" (or "Decision sent").
- Done when: the proposal shows the green **Accepted** pill and a session appears on **Sessions**.
- Watch out: Reviewers need the **Proposal reviewer** role in **Staff roles**. **Assign reviewers evenly** assigns reviews.

### Create sponsor packages and an add-on
- For: Event staff
- Starts on: Sponsors and exhibitors (Tickets and sales group), **Packages** folder tab
- Needs in the demo: at least one ticket (for passes)
- Steps:
  1. Click **Add package**. A **New package** section opens.
  2. Type **Name** (for example "Gold"), **Price**, **How many to sell**, pick **Kind** **Sponsor**, type **Event passes included**, pick **Passes use ticket**.
  3. Check **Welcome screen** under **Where the logo shows in the app**. Type benefits, one per line.
  4. Click **Save**. A toast says "Saved".
  5. Add a second package with **Kind** **Exhibitor booth** and **Includes a booth**.
  6. Click the **Add-ons** folder tab, click **Add add-on**, type **Name** (for example "Electricity") and **Price**, check booths under **Offered with**, click **Save**.
- Done when: both packages and the add-on are listed.
- Watch out: **Move up** changes the order buyers see.

### Add a sponsor and record a payment
- For: Event staff
- Starts on: Sponsors and exhibitors, **Sponsors** folder tab
- Needs in the demo: a sponsor package; a made-up company with a team inbox
- Steps:
  1. Click **Add sponsor**. Type **Company**, **Contact**, **Email**, pick **Package**, click **Add**. The new row opens.
  2. In **Payments**, click **Record**. Type **Amount**, pick **How paid** **Check**, pick **Paid on**, type a note. Click **Save**. A toast says "Payment recorded".
  3. In **Event passes**, click **Add person** to give a pass (the Add attendee panel opens preset to **Sponsor guest**).
  4. In **Benefits**, check a benefit when it is done.
  5. In **In the app**, click **Edit**, upload the logo, check **List in the attendee app**, click **Save**.
- Done when: **Paid** shows "Paid" (or what is owed) and the sponsor shows in the app under Sponsors.
- Watch out: **Send invoice**, **Send agreement**, **Resend** email the contact. **Charge now** charges a saved card or bank account; never click it on a real sponsor. **Delete** also removes payments and leads; use **Status** **Cancelled** to keep the record.

### Set up the sponsor and exhibitor checkout pages
- For: Event staff
- Starts on: Checkout page, **Sponsors** folder tab
- Needs in the demo: sponsor packages
- Steps:
  1. In **Sponsor page**, click **Edit**.
  2. Set **Page** to **Open**, type **Title** and **Intro**, check the packages under **Packages on the page**.
  3. Under **How sponsors can pay**, check **Pay in full** and **Pay by invoice** (and **Pay a deposit** with **Deposit** and **Rest charged on** if wanted). Pick **Payment methods**.
  4. Pick **Agreement to sign** (for example the sponsor agreement) and type **Email new sponsors to** (a team inbox).
  5. Click **Save**. A toast says "Sponsor page saved".
  6. Click **Preview** in **Sponsor checkout link** to open the page.
- Done when: the **Page** pill reads **Open** and the public page shows the packages.
- Watch out: Pages start **Closed**. Bank payments need ACH Direct Debit turned on in Stripe. Repeat on the **Exhibitors** folder tab for booths.

### Edit an agreement template and send it
- For: Event staff
- Starts on: Agreements (Setup group)
- Needs in the demo: the default agreements; a sponsor or speaker with a team inbox
- Steps:
  1. Click **Open** on the sponsor agreement. The text and **Signing** show.
  2. Click **Edit**. The **Edit agreement** view opens.
  3. Put the cursor in the text and click a chip under **Insert a field** (for example **Package name**). A green chip appears.
  4. Fill **Cancel by date** and **Cancel fee**. Pick **When they sign** **On the checkout page**. Type **Organization signer** and **Title**. Check **Countersign automatically**.
  5. Click **Preview** to see it with sample details. Close it.
  6. Click **Save**. A toast says "Saved".
  7. To send one: open the sponsor on **Sponsors and exhibitors**; in its details click **Send agreement**. For speakers, use **Send** on the speaker row.
- Done when: the agreement row shows **Last edited** today and **Signed** counts rise as people sign.
- Watch out: Agreements already sent or signed keep their text. "Have your attorney review your agreement before you use it." The Speakers page message "Add a speaker agreement first: Sponsors and exhibitors, Agreements tab." points to an old place; agreements now live on **Agreements** under Setup.

### Upload a venue map and place pins
- For: Event staff
- Starts on: Sponsors and exhibitors, **Venue map** folder tab
- Needs in the demo: a floor plan image (not a real customer's venue plan)
- Steps:
  1. Type a floor name (for example "Level 1") and click **Upload map**. Pick the image. A floor card appears.
  2. Click **Edit** on the floor.
  3. Pick **booth** in "Click the map to add a", then click on the map. A pin labeled "Booth " appears and its **Label** box is ready; type "Booth 14".
  4. Pick **meeting spot** and click to add a meeting place; label it.
  5. Click **Save**. A toast says "Saved".
- Done when: the floor shows the pins, and the app's **Venue map** shows them.
- Watch out: A pin named like "Booth 14" links to the exhibitor at booth 14. Meeting spot and room pins become choices in **Request a meeting**. **Delete map** removes the floor.

### Moderate the community and photos
- For: Event staff
- Starts on: Community (In the app group)
- Needs in the demo: a demo post, and a demo photo posted from the app
- Steps:
  1. Click **New topic**. Type **Name**, **Description**, pick **Category**, check **Pin to the top**, click **Add**.
  2. In **Topics**, click **Details** on the topic. Type in **Post as the event team** and click **Post**. A toast says "Posted".
  3. Use **Pin** or **Lock** on a row. Under **Reported posts**, click **Keep** or **Remove**.
  4. Open **Photos** (In the app group). In **Photo settings**, click **Edit**, set **New photos** to **Event team reviews first**, click **Save**.
  5. On **Waiting for review**, click **Post** on a photo. It moves to **Posted**.
- Done when: the topic and post show in the app, and the photo shows in the app's **Photos**.
- Watch out: Setting **Photos in the app** to **Off** removes Photos from the admin menu too; turn it back on in **Branding**, **In the app**. The Community banner says "Turn it on in Event settings", but the switch is on **Branding**.

### Add a staff role and invite a check-in volunteer
- For: Event staff (Event admin)
- Starts on: Staff roles (People group)
- Needs in the demo: a team inbox for the volunteer
- Steps:
  1. The **Check-in volunteer** row is open. Under **People in this role**, type the email in "Add a person by email" and click **Add**. A toast says "Added. We emailed <email> a sign-in link."
  2. To make a new role, click **Add role**. A "New role" opens. Type **Role name**, pick **Access ends**, then set each area to **Edit**, **View** or **No access**.
  3. Click **Save**. A toast says "Saved".
- Done when: the role's **People** count rises and **Can see** lists its areas.
- Watch out: Adding a person always emails them. Booth staff also need **Pick their vendor**. Built-in roles cannot be deleted.

### Read reports and export them
- For: Event staff
- Starts on: Reports (Setup group)
- Needs in the demo: some registrations, check-ins and evaluations
- Steps:
  1. Read the number strip: **Registered**, **Checked in**, **Opened the app**, **CE hours issued**.
  2. Scroll **Sessions**, **Registrations by ticket**, **Registrations by day**, **Vendors**, **Engagement**.
  3. Click **Export** on **Sessions**, or **Export all** at the top. A CSV downloads.
- Done when: the CSV file is downloaded.
- Watch out: Exports contain names and emails; only open demo exports on video.

### Speakers

### Sign the speaker agreement
- For: Speakers
- Starts on: the emailed sign link `/sign/<code>` (staff can get it with **Copy sign link** on the speaker row)
- Needs in the demo: a demo speaker with a team inbox and a speaker agreement sent
- Steps:
  1. Open the link. **Sign your speaker agreement** shows the session summary.
  2. Click **Read full agreement** to scroll through it.
  3. Under **May we record your session?** pick **Yes** or **No** (when asked).
  4. Type **Full name** and **Credentials**. The signature preview shows the name in script.
  5. Check "I have read this agreement and I agree to it."
  6. Click **Sign agreement**. **Thank you for signing** shows.
  7. Click **View signed copy**, then **Download PDF**.
- Done when: the Speakers page shows a green "Signed <date>" pill for that speaker.
- Watch out: The link is the key; never show it on video.

### Upload slides and update the bio on the speaker page
- For: Speakers
- Starts on: the speaker page `/speak/<token>` (from the speaker's emails, or **Speaker page** in the app's Home list when signed in with the speaker's email)
- Needs in the demo: a demo speaker on a session; a sample PDF
- Steps:
  1. In **Slides and handouts**, click **Choose files** and pick the PDF. A progress bar runs; a toast says "File uploaded" and a **Received** pill shows.
  2. Under **Share with attendees**, pick **After my session starts**. A toast says "Saved".
  3. In **Bio and photo**, click **Edit**, click **Upload photo**, type **Credentials**, **Job title**, **Organization**, **Bio**, click **Save**. A toast says "Bio saved".
- Done when: the admin Sessions **Slides** tab shows the file and the attendee app shows the new bio.
- Watch out: Files are PDF, PowerPoint or Word, up to 100 MB each. **Replace** and **Remove** affect only the speaker's own files.

### Sponsors and exhibitors

### Buy a sponsorship on the sponsor checkout page
- For: Sponsors and exhibitors
- Starts on: `/r/<slug>/sponsor` (from **Preview** or **Copy link** on the Checkout page, Sponsors tab)
- Needs in the demo: the sponsor page **Open** with **Pay by invoice** on; a team inbox
- Steps:
  1. Pick a package card and click **Continue**.
  2. On **Company**, fill **Company name**, **Website**, **First name**, **Last name**, **Email**, **Mobile**; click **Upload** for the logo; type **About your company**; fill pass names. Click **Continue**.
  3. On the agreement step, type **Full name** and **Title**, check the box, click **Sign and continue**.
  4. Under **How to pay**, pick **Pay by invoice**. Click **Request invoice**.
  5. The done page says "You are a <package> sponsor". Click **Add names** or **View** under **Next steps**.
- Done when: the sponsor shows on the admin **Sponsors** tab with what is owed and a signed agreement.
- Watch out: **Pay in full** and **Pay a deposit** open Stripe's card or bank form; never type a real card. The invoice is emailed to the contact. Exhibitors use `/r/<slug>/exhibit` the same way.

### Scan leads at the booth
- For: Sponsors and exhibitors (booth staff)
- Starts on: the app, **Home**, **More** list, **Scan leads** (`/e/<slug>/leads`)
- Needs in the demo: an exhibitor with **Booth staff can scan attendee badges for leads** on and a team email in **Booth staff emails**; a demo attendee badge on another device
- Steps:
  1. Sign in to the app with the booth staff email. Open **Scan leads**.
  2. Allow the camera and point it at the attendee's **My badge** QR. Or type the code in "Or type the badge code" and click **Look up**.
  3. The person's card shows. Pick **Interest** **Hot**, type a **Note**, click **Save lead**. A toast says "Lead saved".
  4. Click **Export my leads** to download a CSV.
- Done when: the header shows "1 lead" and the lead is in the list.
- Watch out: "Lead scanning is for booth staff..." means the email is not booth staff for that vendor. Organization admins can open `/leads` by address and pick any **Booth**.

### Attendees in the app

### Register on the checkout page and get the app
- For: Attendees in the app
- Starts on: `/r/<slug>`
- Needs in the demo: a ticket priced 0.00 and On; a team inbox
- Steps:
  1. Pick a choice under **Who is registering?** (if shown), then click **Select** on the free ticket.
  2. Click **Continue**.
  3. Fill **First name**, **Last name**, **Email**, and the questions (use made-up license numbers). Leave the text consent unchecked.
  4. Click **Register**. The page says "You're registered, <name>".
  5. Click **Install the app** to open **Get the app**, then **Open the app**.
- Done when: the person appears on **Attendees** with **No charge**, and the welcome email arrives in the team inbox.
- Watch out: Paid tickets go to **Continue to payment** and Stripe; never enter a real card. The welcome email sends to the email typed.

### Sign in to the app and show my badge
- For: Attendees in the app
- Starts on: `/e/<slug>`
- Needs in the demo: a registered demo attendee with an inbox Simone can read; event status Live (or staff access)
- Steps:
  1. Type the email in **Email** and click **Email me a code**.
  2. Type the code into the six boxes and click **Sign in**. **Home** opens.
  3. Under **Your pass**, click **My badge**. The QR and name show.
- Done when: **My badge** shows the QR code and "Show this code at the registration desk to get your badge."
- Watch out: "We could not find your registration" means that email is not registered; click **Try a different email**.

### Build my agenda
- For: Attendees in the app
- Starts on: the app's **Agenda** tab
- Needs in the demo: several published sessions
- Steps:
  1. Tap a day button at the top.
  2. Tap **CE eligible** to filter, or the search button and type a word.
  3. Tap the **+** on a session. A toast says "Added to My agenda" and a check mark replaces the **+**.
  4. Tap a session title to open it; turn on **Remind me 15 minutes before**.
  5. Tap **My agenda** in the switch at the top to see the list.
- Done when: **My agenda** lists the sessions with an **Upcoming** pill and the **Sessions** count.
- Watch out: Full sessions show **Full** and cannot be added. On a session, **On my schedule** removes it when tapped.

### Check in to a session, take the evaluation, get the certificate
- For: Attendees in the app
- Starts on: the session page in the app, or **Up next for you** on Home
- Needs in the demo: a CE session happening now (or a staff-added check-in, see "Add a session check-in by hand"); **Evaluation opens** set to **At check-in** for a quick demo; the printed door QR or the **Room code**
- Steps:
  1. Tap **Check in**. The **Check in** screen opens with "Scan the code posted at the door" (the camera shows on phones that can scan).
  2. Scan the door QR, or tap **Type the room code instead**, type the **Room code**, tap **Check in**. **You are checked in** shows.
  3. Tap **Take evaluation**. Answer each question (tap 1 to 5).
  4. Tap **Submit and get certificate**. A toast says "Submitted. Your certificate is ready." and **CE credits** opens.
  5. Tap **View** on the certificate.
- Done when: **CE credits** shows the hours earned and the certificate with an **Issued** pill.
- Watch out: Check-in works only from 30 minutes before the start to 15 minutes after the end. A wrong code says "That code is not for this session...". The certificate is also emailed.

### Message someone and request a meeting
- For: Attendees in the app
- Starts on: the app's **People** tab
- Needs in the demo: two demo attendees both shown in People; messaging and meeting requests on
- Steps:
  1. Tap **Message** next to a person. A conversation opens.
  2. Type in "Write a message" and tap the send arrow.
  3. Go back, tap the person's name, then **Request meeting**.
  4. Pick a day, a time under "Times you are both free", a **Length** and **Where**. Tap **Send request**. A toast says "Request sent".
  5. On the other person's device, open **Messages** and tap **Accept** under **Meetings**.
- Done when: the meeting card shows **Confirmed**.
- Watch out: Messages stay between attendees; the event team does not see them. **Block** in the "..." menu stops messages both ways.

### Join the community, vote in a poll and post a photo
- For: Attendees in the app
- Starts on: the app's **Community** tab
- Needs in the demo: Community, Live polls and Q&A, and Photos on; a poll opened by a presenter on a session; a sample photo with no real people
- Steps:
  1. Tap **Join** on a topic, open it, type a post and tap the send arrow.
  2. Open a session, tap **Live poll and Q&A**, tap an answer. Results show with "(your vote)". Type a question in "Ask the speaker a question" and send it.
  3. Go to **Home**, tap **Photos**, tap **Add photos**, pick the image, type a caption, tap **Post 1 photo**.
- Done when: the post shows in the topic, the vote shows in results, and the photo shows (or says "Waiting for review").
- Watch out: Presenters create polls with **New poll** and **Open now** on the same screen. Photos may need event team review first.

## Words the app uses

- **Organization**: the group that runs events. Has an owner, admins, colors, a logo and one Stripe account.
- **Event**: one conference. Has dates, a time zone, a status and its own branded app.
- **Status**: **Draft** (attendees cannot open the app), **Live**, **Ended**.
- **Event allowance**: how many events an organization may add (shown as "Events included").
- **Slug** or app address: the event's part of the web address, as in `/e/<slug>`.
- **Attendee**: a registered person. **Badge type**: Attendee, Speaker, Exhibitor staff, Staff, Guest, Volunteer, Sponsor guest.
- **Ticket**: what people buy. **Buyer choices** ("Who is registering?") such as Member, Non-member, Student.
- **Early bird**, **Regular**, **Late**: prices by date on a ticket.
- **Coupon**: a discount code.
- **Checkout page**: the public registration page at `/r/<slug>`.
- **Welcome email** and **Follow-up messages**: automatic emails (and texts) to attendees, speakers, sponsors and exhibitors.
- **Session**: a program item. **Kind**: Session, Keynote, Workshop, General session, Break, Meal. **Track**: a topic group.
- **CE hours**: continuing education hours a session gives.
- **Room code** and **door QR**: the code posted at a session room for check-in.
- **Check-in** (event): at the registration desk, with a printed badge. **Session check-in**: scanning the door QR in the app.
- **Evaluation**: the survey after a session. **Certificate template**: how CE certificates look and when they issue.
- **Speaker page**: the speaker's own page for slides, bio and agreement.
- **Proposal**: a session idea sent through the call for proposals. **Blind review** hides presenter names from reviewers.
- **Sponsor**, **Exhibitor**, or both: a company (shown as "Vendors" in staff role access).
- **Package**: a sponsorship level or exhibitor booth. **Add-on**: an extra like electricity. **Pass**: a free registration a package includes. **Benefits**: a package's checklist.
- **Pay link**: a link to pay what is owed. **Deposit**: part paid now, the rest charged on a date. **Invoice hold**: days a package is held for an invoice.
- **Agreement template**: the sponsor, exhibitor or speaker agreement. **Countersign**: the organization's signature added automatically.
- **Staff role**: what an event staff member can open. Areas are **Edit**, **View** or **No access**. Built-in roles: Event admin, Check-in volunteer, Proposal reviewer, Booth staff, Speaker.
- **Announcement**: a message to attendees by push and email, also shown as an **Alert** in the app.
- **Push**: a phone notification. Attendees turn it on with **Turn on** under **Notifications**.
- **Topic**: a community discussion. **Lead**: a badge scanned by booth staff, rated Hot, Warm or Cold.
- **Floor** and **pin**: a venue map image and a labeled spot on it (Room, Booth, Service, Meeting spot).
- **LeadDash platform tag**: a label used when copying registrants into the organization's LeadDash platform account.
- **Folder tabs**: tabs with a lip along the top of a card, used to filter lists.
- **Number strip**: the thin row of labels and bold numbers at the top of admin pages.

## Never

- Never record a customer's live event or real attendees, speakers, sponsors or exhibitors. Use only the demo organization and demo event.
- Never show a real customer's name or details in a video or SOP (no real organization's name, logo or people). Use generic names like "Demo Organization".
- Never charge a real card or bank account. Do not type real card numbers into Stripe's form. Do not click **Charge now**, **Refund**, **Connect with Stripe** or **Disconnect** on a real organization.
- Never send real emails, texts or push notices to real people. Before clicking **Send**, **Schedule**, **Send to new**, **Send agreements**, **Send agreement**, **Resend**, **Send welcome**, **Send invoice**, **Request update**, **Remind**, **Remind missing**, **Issue**, **Resend** (certificate), or adding someone to a staff role, check that every recipient is a team-controlled demo address.
- Never change an event's dates or status after it is over. Never set a live event to **Ended**.
- Never delete anything outside the demo. Deleting a session removes its check-ins; deleting a speaker removes them from every session; deleting a sponsor removes its payments and leads.
- Never create test events in a customer's organization. Events cannot be deleted and use up the organization's allowance.
- Never click **Make owner** or **Transfer ownership**, or remove admins, on a real organization.
- Never click **New code** on a session after its door QR is printed.
- Never revoke a real certificate.
- Never check **Add the person to the LeadDash platform with the tag** in a demo; it copies registrants into a real LeadDash platform account if one is connected.
- Never show sign-in codes, sign links (`/sign/...`), speaker page links (`/speak/...`), pay links, or exported CSV files with real data on video.
- Never record the **LeadDash tools** page in customer-facing material.
- Never add client or patient health information anywhere, including dietary or accessibility answers, notes, posts and photos. Use plain made-up sample text.
- Never upload photos of real people without permission; use stock or illustrated images.
