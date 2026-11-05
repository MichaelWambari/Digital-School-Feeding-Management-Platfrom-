# DSFMP — Digital School Feeding Management Platform

A mobile app for running a school feeding programme: registering
students, recording meal attendance (by hand or with NFC cards), keeping
the school's food stock, recording the food each meal uses, and
reporting on all of it.

Built with **React Native (Expo)** and **Supabase** (PostgreSQL, Auth,
row-level security). Runs on Android, iOS and the web.

## Features

Each school uses DSFMP **independently**. Its students, staff, readers, food
stock and records belong to it alone, and the database (row-level security)
stops any school from seeing another's. The school's **headteacher** runs its
account. A **platform admin** onboards schools and (soon) verifies
suppliers, but can't see any school's records.

| Module | What it does |
|---|---|
| **Login** | Sign in with email and password, then a 6-digit code emailed to you, or with **Continue with Google**. Only people added by their school can sign in. A login created by someone else must choose its own password at its first sign-in. Sessions persist across app restarts. |
| **Dashboard** | The school's name, active student count and a tile for each module the user may use, plus a light/dark/system theme switch. |
| **Students** | Searchable list of the school's students with an add/edit form. |
| **Attendance** | Choose breakfast, lunch or supper and mark each active student present for today. Tap again to undo. Shows a present/total count and includes NFC scans. |
| **Inventory** | The school's stock, with low-stock warnings, a per-food reorder level (set by the headteacher) and the history of food received and used. **Received** records food that arrived, with the amount checked on arrival and who delivered it. A database trigger keeps every stock level correct and blocks using more than is in stock. |
| **Distribution** | After each meal, record how much of each food was used; the app shows the portion per student from that meal's attendance. Also lists dispatches from the old central store (see below); one still in transit can be received. |
| **Reports** | For today, the last 7 days or the last 30 days: meals served per meal with average attendance %, a daily attendance chart, food used per item, and current stock with low-stock items flagged. |
| **Staff** | *Headteacher only:* create logins for the school's staff, give each a role, suspend or restore them, and reset passwords. |
| **Permissions** | *Headteacher only:* choose what the coordinator, inventory officer and staff roles may do at the school. |
| **School** | The school's profile (name, registration number, contacts, timezone). Only the headteacher can change it. |
| **Schools** | *Platform admin only:* onboard a school with its first headteacher, and suspend or restore a school's account. |
| **NFC scanning** | Card readers (e.g. an ESP32) call one database function, `record_nfc_scan()`, to record a student's attendance at the current meal. Each reader belongs to a school and only accepts that school's cards. Every scan is logged for audit. |

The network central store that used to supply schools is **retired**: nothing
new can be dispatched from it, its history stays in the database, and a
dispatch still in transit can be received on the Distribution screen.

### Roles

Every user has one role, and the database enforces it with row-level security:

| Role | Can do |
|---|---|
| `headteacher` | Everything at their school: profile, staff, permissions, students, meals, stock, readers, reports, and (soon) supplier choices and order confirmation. A school always keeps at least one active headteacher. |
| `coordinator` | By default: manage students, record attendance and food used, manage meals, see stock, nutrition and reports |
| `inventory_officer` | By default: see stock and orders, confirm deliveries, enter stock counts, see reports. Never approves or starts orders: reordering is automatic and orders are confirmed by the headteacher. |
| `staff` | By default: see students and record attendance |
| `platform_admin` | Onboard schools, suspend or restore them, keep the shared food list and (soon) verify suppliers. No access to any school's students, attendance, stock or reports. |

The headteacher can change the defaults for each role on the **Permissions**
screen (`school_role_permissions`). Managing staff, choosing suppliers and
confirming orders can't be given away. A login with no role sees nothing.

### Meal serving windows

Each school sets its own serving windows and timezone in the `schools` table.
NFC attendance scans are filed under the meal whose window they fall in. New
schools start with these defaults (Africa/Nairobi time):

| Meal | Window |
|---|---|
| Breakfast | 06:00–07:00 |
| Lunch | 12:00–14:00 |
| Supper | 18:00–20:00 |

Scans outside every window are rejected with `outside_meal_time`. Leave a
meal's start and end empty if the school doesn't serve it.

## Tech stack

- **App:** Expo SDK 58, React Native 0.88, React 19, TypeScript, React Navigation, React Native Paper
- **Backend:** Supabase: PostgreSQL, Auth, row-level security, triggers and `security definer` functions
- **Hardware (optional):** NFC readers that call the `record_nfc_scan` RPC over HTTPS

## Project structure

```
dsfmp-app/                  The Expo app (run all commands from here)
  App.tsx                   App entry: theme provider + navigator
  src/
    lib/supabase.ts         Supabase client (project URL + anon key)
    navigation/             Auth-based routing (logged out → Login)
    school/SchoolContext.tsx  Signed-in user's profile, school and permissions;
                            use useAccount(), or useSchool() on school screens
    screens/                One file per module (Login, Dashboard, Students,
                            Attendance, Inventory, Distribution, Reports, Staff,
                            Permissions, SchoolProfile); the platform admin has
                            PlatformDashboard and Schools
    lib/manageStaff.ts      Calls the manage-staff Edge Function
    theme/ThemeContext.tsx  Light/dark/system colours; use makeStyles + useThemedStyles
  supabase/
    schema.sql              Base database up to fix 008 (run fixes 009+ after it)
    fixes/NNN_*.sql         Migrations for an existing database, run in number order
    checks/health_check.sql Read-only check of structure, links and data (OK/WARN/FAIL)
    seed/demo_data.sql      Demo schools, students, readers, stock and a week of history
    seed/staple_foods.sql   Twelve staple foods (old central-store version; don't run after fix 009)
    functions/manage-staff/ Edge Function that creates logins, resets passwords and onboards schools
    functions/login-code/   Edge Function that emails and checks sign-in codes
  scripts/simulate-reader.mjs  NFC reader simulator (npm run simulate)
  firmware/wokwi/           ESP32 reader firmware, runnable in the Wokwi simulator
  firmware/reader/          ESP32 reader firmware for the real PN532 reader
```

## Database

The database has these tables (`schema.sql` plus the fixes from 009 on):

| Table | Purpose |
|---|---|
| `schools` | Each independent school: profile, timezone, meal serving windows and status (`active` or `suspended`) |
| `users` | Profile, role and school for each Supabase Auth user, created automatically (with no role) on sign-up |
| `school_role_permissions` | What each role may do at each school, set by the headteacher |
| `beneficiaries` | Students at each school, with their NFC tag IDs |
| `nfc_devices` | Registered card readers, each at one school |
| `food_items` | The shared food list (name, unit: `kg` or `litres`, bag size), kept by the platform admin |
| `inventory_items` | Each school's stock of each food it has received |
| `food_consumption` | Food a school used at one meal on one day |
| `inventory_transactions` | School stock received (with the supplier) or used at meals. A trigger updates `inventory_items`. |
| `meal_attendance` | One row per student, meal and day |
| `reports` | Saved reports (export is planned) |
| `nfc_tag_logs` | Audit log of every NFC scan and its outcome |
| `audit_logs` | Who changed schools, staff, permissions, students, reorder levels and deliveries, and when |
| `food_distribution`, `central_transactions` | History of the retired central store (read-only) |

Every school record has a `school_id`. Attendance, food used and stock
movements take theirs automatically from the student or item, so a record
can't end up filed under the wrong school. The policies only show a school's
records to its own staff while the school is active
(`can_view_school()`, `has_school_role()`, `has_school_permission()`).
Stock never changes directly: recording food received
(`record_stock_received()`), receiving an old dispatch
(`receive_distribution()`) and recording food used each add a transaction,
and triggers keep the stock levels in step. Every permission rule also
requires `session_verified()`: a password login can't see or change anything
until its emailed code is entered (`login_codes`), while Google logins need
no code. Headteachers list and edit their staff with `list_staff()` and
`update_staff()`; the platform admin uses `list_schools()` and
`set_school_status()`. In the database, students are still called
`beneficiaries`. `nfc_tag_logs` deliberately has no foreign keys on the card
and reader, so scans from unknown cards or unregistered readers are still
recorded.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) LTS, v20 or newer
- A [Supabase](https://supabase.com) project (the free tier is fine)
- [Expo Go](https://expo.dev/go) on your phone, or an Android emulator / iOS simulator

### 1. Set up the database

1. In your Supabase project, open the **SQL Editor**, paste the contents of
   `dsfmp-app/supabase/schema.sql`, and run it. Then run each file in
   `dsfmp-app/supabase/fixes/` from `009_independent_schools.sql` on, in
   number order (`schema.sql` already includes fixes 001–008).
2. Copy the **Project URL** and **anon/publishable key** from
   **Project Settings → API** into `dsfmp-app/src/lib/supabase.ts`.

> **Warning:** `schema.sql` is a bootstrap script. It **drops and recreates**
> the tables, so running it on a live database deletes their data. To update
> an existing database, run only the files in `dsfmp-app/supabase/fixes/`
> it doesn't have yet, in number order.

3. Optional: run `dsfmp-app/supabase/seed/demo_data.sql` to load demo data.
   It adds three more schools (Tumaini, Upendo and Baraka), each with
   test students and NFC card IDs, a registered reader, opening stock, and a
   week of past attendance and food used at meals, plus a reader for Jasiri
   School. It leaves one rice dispatch to Tumaini in transit, ready to
   receive. It only adds missing rows, so it's safe to run again or on a live
   database. The demo schools have no headteacher until you add one (step 3).

### 2. Install and run

```bash
cd dsfmp-app
npm install
npx expo start        # then scan the QR code with Expo Go
npx expo start --web  # or run in the browser at http://localhost:8081
```

Your phone and computer must be on the same Wi-Fi network. If that doesn't
work (on school or office networks, for example), use `npx expo start --tunnel`.

### 3. Create the platform admin

1. In Supabase, go to **Authentication → Users → Add user → Create new
   user**. Enter an email and password and tick **Auto Confirm User**. A
   trigger adds a matching `users` row with no role.
2. Make that user the platform admin in the **SQL Editor**:

   ```sql
   update public.users u set role = 'platform_admin', school_id = null
   from auth.users a
   where a.id = u.user_id and a.email = 'you@example.com';
   ```

A new database starts with one school, **Jasiri School**, with no
headteacher. Give a user that role the same way
(`set role = 'headteacher', school_id = (select school_id from schools where name = 'Jasiri School')`),
or onboard new schools from the app (below).

### 4. Onboarding schools and staff accounts

Logins are created in the app, through the `manage-staff` Edge Function,
because creating a login takes the service role key, which must never be in
the app:

1. In Supabase, open **Edge Functions → Deploy a new function → Via Editor**.
2. Name it `manage-staff`, paste the contents of
   `dsfmp-app/supabase/functions/manage-staff/index.ts` and deploy.
   Supabase gives the function its URL and service role key automatically.
3. In the function's settings, turn off **Verify JWT**. The function checks
   the signed-in user itself.

**Onboarding a school:** the platform admin opens **Schools → Onboard**, enters
the school's details and its headteacher's name, email and a temporary
password, and taps **Onboard school**. The school gets the default role
permissions. Give the headteacher the email and password; they choose their
own password when they first sign in, and from then on they run the school.

**Staff:** the headteacher opens **Staff → Add**, enters the person's name,
email and a temporary password, chooses their role and taps **Create login**.
Tap someone in the list to change their role, suspend them (they can still
sign in but see nothing) or set a new temporary password. To hand over the
school, make someone else headteacher; they can then change your role.

### 5. Sign-in codes

After a password sign-in, the app emails a 6-digit code that must be entered
before that login can see anything. The database enforces this. Codes are
sent by the `login-code` Edge Function through [Brevo](https://www.brevo.com)
(free for 300 emails a day).

Set it up **before** running `supabase/fixes/006_login_codes.sql`. Otherwise
password sign-ins can't get a code and only Google sign-ins will work.

1. Create a free Brevo account. Under **Senders, Domains & Dedicated IPs →
   Senders**, add the address codes should come from (your Gmail works) and
   confirm it from the email Brevo sends.
2. Under **SMTP & API → API Keys**, generate an API key.
3. In Supabase, open **Edge Functions → Secrets** and add `BREVO_API_KEY` (the
   key) and `LOGIN_CODE_FROM` (the sender address).
4. Deploy `dsfmp-app/supabase/functions/login-code/index.ts` as a function
   named `login-code`, the same way as `manage-staff`, and turn off
   **Verify JWT** for it. Redeploy `manage-staff` too, since it now also
   checks for a finished sign-in.
5. Run `supabase/fixes/006_login_codes.sql` in the SQL Editor.

If codes don't arrive, the code screen shows Brevo's error. A common one is
an unrecognised IP address: turn off **Security → Authorised IPs** in Brevo,
because Supabase's servers don't have fixed addresses.

### 6. Google sign-in

Staff can tap **Continue with Google** instead of using a password and code.
Google matches them to their account by email, so their Google email must be
the one added in Staff.

1. In the [Google Cloud console](https://console.cloud.google.com), create a
   project and set up the **OAuth consent screen** (External, app name
   DSFMP). While it is in testing, add each staff member's Gmail address as a
   test user, or publish the app.
2. Under **Credentials → Create credentials → OAuth client ID**, choose **Web
   application** and add this authorised redirect URI:
   `https://<your-project>.supabase.co/auth/v1/callback`.
3. In Supabase, open **Authentication → Sign In / Providers → Google**, turn it
   on, and paste the client ID and secret.
4. Under **Authentication → URL Configuration → Redirect URLs**, add
   `http://localhost:8081`, `exp://**` (Expo Go) and `dsfmp://**` (app builds),
   plus the web address once the app is hosted.
5. Under **Authentication → Sign In / Providers**, turn off **Allow new users
   to sign up**. Only people already added in Staff can then sign in. Staff
   created in the app are not affected.

## Development notes

- Screens query Supabase directly (`supabase.from('table').select()`,
  `.insert()`, `.update()`). Permission rules live in the database's RLS
  policies, not in the app.
- Every school screen works on the user's school: get it with `useSchool()`
  and filter queries with `.eq('school_id', school.school_id)`. Send
  `school_id` when creating students; other tables fill it in automatically.
  Show or hide actions with `useSchool().can('permission')` (or
  `isHeadteacher`), matching the database's `has_school_permission()`.
  The platform admin's screens use `useAccount()` and have no school.
- Style screens with `makeStyles(c: Colors)` and `useThemedStyles` from
  `src/theme/ThemeContext.tsx` instead of hard-coding colours.
- Database changes go in a new `supabase/fixes/NNN_description.sql` that is
  safe to run on live data (and safe to run twice). `schema.sql` stays the
  base up to fix 008; add any new tables and functions to its drop list so a
  reset still clears them.
- Add native libraries with `npx expo install <package>` so their versions
  match the Expo SDK.

## NFC reader simulator

Until the ESP32 reader arrives, `scripts/simulate-reader.mjs` stands in for
it. Each tap sends the same request the firmware will send
(`POST /rest/v1/rpc/record_nfc_scan` with the anon key), then prints the
result and round-trip time, followed by a summary with min/avg/p95/max
latency. Run it from `dsfmp-app/`, using the readers and card IDs from the
demo seed:

```bash
npm run simulate -- --device reader-tumaini-01 --tag A1000001
npm run simulate -- --device reader-tumaini-01 --tag A1000001,A1000002,A1000003
npm run simulate -- --device reader-baraka-01 --tag C3000001 --repeat 20 --interval 500
npm run simulate -- --help
```

Taps only succeed inside the school's meal windows; outside them the result
is `outside_meal_time`. Readers record attendance only; food used is recorded
per meal in the app. Add `--json` to get one JSON line
per tap for test records. Taps are real: they write to the database the app
uses, and every tap, including failed ones, is logged in `nfc_tag_logs`.

## Building for release

Build installable apps with [EAS Build](https://docs.expo.dev/build/introduction/):

```bash
npm install -g eas-cli
eas build -p android   # APK/AAB
eas build -p ios       # requires an Apple Developer account
```

Run these from `dsfmp-app/`. Before publishing, change the `com.dsfmp.app`
identifiers in `dsfmp-app/app.json`.

## Roadmap

Progress is tracked in
[GitHub milestones](https://github.com/MichaelWambari/Digital-School-Feeding-Management-Platfrom-/milestones):

1. **Sprint I: Foundation.** Keys moved out of the code, seed data, automated checks, and NFC reader hardware procured and wired.
2. **Sprint II: Core workflow & testing.** Card tap → reader → database → app end to end (with a reader simulator until the hardware arrives), ESP32 firmware, a test record, and latency and reliability measurements.
3. **Sprint III: Completion & hosting.** Web hosting on Cloudflare Pages, an Android build, multi-school support, offline buffering on the reader, the remaining features, and user acceptance testing.
