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
stops any school from seeing another's. There is no central administrator:
a **headteacher** creates an account in the app, names their school and runs
it, and adds a **coordinator** to run things day to day.

| Module | What it does |
|---|---|
| **Login** | Sign in with email and password, then a 6-digit code emailed to you, or with **Continue with Google**. A new headteacher taps **Create an account**; coordinators are added by their headteacher and don't sign up. A login created by someone else must choose its own password at its first sign-in. Sessions persist across app restarts. |
| **Set up your school** | Shown once, to a new account: the headteacher enters their name and the school's name (and optionally county and area), which creates the school with a Monday–Friday timetable and makes them its headteacher. |
| **Dashboard** (getting started) | Until they're done, the headteacher sees four first steps: set meal times and a dish with its serving, add students, record food in stock, add a coordinator. |
| **Dashboard** | The school's name, active student count and a tile for each module the user may use, plus a light/dark/system theme switch. |
| **Students** | Searchable list of the school's students with an add/edit form. Tap a student for their **feeding report**: meals attended (breakfast, lunch, supper) and the estimated nutrients provided (energy, protein, carbohydrates, fat, fibre, calcium, iron, zinc, vitamins A and C) per day and in total, over 7, 30 or 90 days, with a daily energy chart and meal-by-meal history. The estimates come from each dish's standard serving, not from what the student actually ate. |
| **Food values** | (From the Timetable.) Nutrients per 100 g or 100 ml of each food, pre-filled with approximate values from the Kenya Food Composition Tables 2018. A school can enter its own values for a food, with their source. |
| **Attendance** | Choose breakfast, lunch or supper and mark each active student present for today. Tap again to undo. Shows a present/total count and includes NFC scans. |
| **Timetable** | The school's weekly feeding timetable: for each day, which meals are served, each meal's attendance window and the dish on the menu. One meal can be saved for several days at once (e.g. lunch Monday–Friday). Each dish has a **per-student serving** (e.g. rice 100 g, beans 80 g, oil 10 ml), so the food a meal used is worked out as students who attended × serving. Staff with "Manage meals" edit it; everyone can view it. |
| **Inventory** | The school's stock, with low-stock warnings, a per-food reorder level (set by the headteacher) and the history of food received and used. **Received** records food that arrived, with the amount checked on arrival and who delivered it. A database trigger keeps every stock level correct and blocks using more than is in stock. |
| **Distribution** | After each meal, record how much of each food was used. If the day's dish has a serving set, the amounts are filled in from students who attended × serving, to check and save; the app also shows the portion per student. Also lists dispatches from the old central store (see below); one still in transit can be received. |
| **Reports** | For today, the last 7 days or the last 30 days: meals served per meal with average attendance %, a daily attendance chart, food used per item, and current stock with low-stock items flagged. |
| **Staff** | *Headteacher only:* add coordinators (with a temporary password), suspend or restore them, and reset passwords. Making a coordinator headteacher hands the school over. |
| **Permissions** | *Headteacher only:* choose what the coordinator may do (everything by default). |
| **School** | The school's profile (name, registration number, contacts, timezone). Only the headteacher can change it. |
| **NFC scanning** | Card readers (e.g. an ESP32) call one database function, `record_nfc_scan()`, to record a student's attendance at the current meal. Each reader belongs to a school and only accepts that school's cards. Every scan is logged for audit. |

The network central store that used to supply schools is **retired**: nothing
new can be dispatched from it, its history stays in the database, and a
dispatch still in transit can be received on the Distribution screen.

### Roles

Every user has one role, and the database enforces it with row-level security:

| Role | Can do |
|---|---|
| `headteacher` | Everything at their school: profile, staff, permissions, students, meals, stock, readers, reports, approving suppliers, and (soon) order confirmation. A school always keeps at least one active headteacher. |
| `coordinator` | Runs the school day to day: students and NFC cards, attendance, the timetable, dishes and servings, inventory (food received, food used) and reports. By default it may do all of these, and it can look at suppliers; it can't manage staff, approve suppliers or confirm orders. |
| `supplier` | A food business with no school. It keeps a business profile (contacts, KRA PIN, registration number, areas served), the foods it supplies and its documents, and asks schools to work with it. |

The headteacher can turn off what the coordinator may do on the **Permissions**
screen (`school_role_permissions`). A new login with no role sees "Set up your
school" or "Set up your supplier account", depending on what was chosen at
sign-up.

### Suppliers

There is no central verification: each school decides which suppliers it
works with. A supplier can ask to supply a school (with a note), and the
headteacher approves or declines it; the headteacher can also pick a supplier
from the **Suppliers** directory and approve it straight away, and remove it
later. A supplier can withdraw a request or stop supplying a school. Before
deciding, the headteacher sees the supplier's details, foods and documents
(PDFs or photos up to 10 MB, kept in a private Storage bucket). Any school's
headteacher, and coordinators allowed to see orders, can browse every
registered supplier; suppliers see only the list of schools (name, county,
town) and where they stand with each.

### Supply requests

When a food is at or below its reorder level, or won't cover the selected
meal, the **Distribution** screen shows it under **Running low**. The
headteacher, or a coordinator allowed to see orders, can request an amount
from one of the school's approved suppliers (those that list the food come
first). The supplier sees the request under **Supply requests** and accepts or
declines it, with a note. When the food arrives, staff who confirm deliveries
record the amount on the **Requests** tab, which adds it to stock as a
delivery from that supplier. A request can be cancelled until it's delivered
(`supabase/fixes/015_supply_requests.sql`).

### Meal timetable

Each school sets its own weekly timetable on the **Timetable** screen
(`meal_schedules`, in the school's timezone). An NFC scan is filed under the
meal whose window, on today's weekday, it falls in. New schools start with
these windows, Monday to Friday:

| Meal | Window |
|---|---|
| Breakfast | 06:00–07:00 |
| Lunch | 12:00–14:00 |
| Supper | 18:00–20:00 |

A scan outside every window is rejected with `outside_meal_time`, and a
second scan for the same meal with `already_recorded`. Windows on the same
day can't overlap. Remove a meal from a day if the school doesn't serve it then.

### Food used and wastage

When the day's dish has servings set (Timetable → dish), the **Food used**
tab on **Distribution** shows an **issue sheet** for the meal: for each food,
the planned amount (the school's active students × one serving) and what's
in stock. The headteacher or a coordinator can change the amounts the
kitchen actually issues and save them.

When the meal's window ends, the meal is **closed**: the issued amounts are
taken out of stock, and each one is split into food **served** (students who
attended × one serving) and estimated **unserved** food (the rest). The
Food used history shows the unserved amount next to each food. Meals close
every 15 minutes through `pg_cron`, and also whenever someone opens the Food
used tab, so it works even where `pg_cron` isn't enabled. Each meal closes
once only. A meal with no attendance and no saved issue sheet counts as not
served, and nothing is taken out of stock. If the store has less than was
issued, only what's in stock is taken, and the sheet says so. Meals whose
dish has no servings are still entered by hand as before. Food can't be
entered by hand for a meal that has already closed automatically, so
nothing is deducted twice (`supabase/fixes/016_meal_close.sql`).

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
                            Permissions, SchoolProfile, Timetable, ...);
                            CreateSchool is shown to a new account
    lib/manageStaff.ts      Calls the manage-staff Edge Function
    theme/ThemeContext.tsx  Light/dark/system colours; use makeStyles + useThemedStyles
  supabase/
    schema.sql              Base database up to fix 008 (run fixes 009+ after it)
    fixes/NNN_*.sql         Migrations for an existing database, run in number order
    checks/health_check.sql Read-only check of structure, links and data (OK/WARN/FAIL)
    seed/demo_data.sql      Old demo data (network model); used by the local tests only
    reset/fresh_start.sql   Deletes every school, record and login (run once, before fix 013)
    seed/staple_foods.sql   Twelve staple foods (old central-store version; don't run after fix 009)
    functions/manage-staff/ Edge Function that creates coordinators' logins and resets passwords
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
| `food_items` | The food list (name, unit: `kg` or `litres`, bag size): shared foods (read-only) and each school's own |
| `inventory_items` | Each school's stock of each food it has received |
| `food_consumption` | Food a school used at one meal on one day |
| `inventory_transactions` | School stock received (with the supplier) or used at meals. A trigger updates `inventory_items`. |
| `meals` | Each school's dishes, e.g. "Rice and beans" |
| `meal_schedules` | The weekly timetable: weekday, meal, attendance window and dish |
| `meal_ingredients` | Each dish's per-student serving: grams (or ml) of each food |
| `food_nutrition` | Nutrients per 100 g/ml of each food: shared values and each school's own |
| `attendance_nutrition` | For each attended meal, the dish, serving and estimated nutrients, as worked out when it was recorded |
| `meal_attendance` | One row per student, meal and day |
| `reports` | Saved reports (export is planned) |
| `nfc_tag_logs` | Audit log of every NFC scan and its outcome |
| `audit_logs` | Who changed schools, staff, permissions, students, reorder levels and deliveries, and when |
| `suppliers` | Each supplier's business profile, one per supplier login |
| `supplier_foods` | The foods (from the shared list) each supplier offers |
| `supplier_documents` | Each supplier's documents; the files are in the private Storage bucket `supplier-documents`, under the supplier's ID |
| `school_suppliers` | Where each supplier stands with each school: `requested`, `approved`, `declined` or `removed` |
| `meal_issues` | The amounts the kitchen saved on a meal's issue sheet |
| `meal_closures` | Each school's closed meals: `closed`, `not_served`, `manual` or `no_recipe` |
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
`update_staff()`; a new account creates its school with
`create_my_school()`, or its supplier profile with `create_my_supplier()`.
Suppliers and schools see each other through `supplier_school_directory()`
and `school_supplier_directory()`, and links change only through
`request_to_supply()`, `withdraw_from_school()` and (headteacher only)
`set_school_supplier()`. In the database, students are still called
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

3. To start an existing database afresh, run
   `dsfmp-app/supabase/reset/fresh_start.sql` **before** fix 013. It
   permanently deletes every school, its records and every login (the food
   list and nutrition values stay). `seed/demo_data.sql` belongs to the old
   network model; don't run it on a live database.

### 2. Install and run

```bash
cd dsfmp-app
npm install
npx expo start        # then scan the QR code with Expo Go
npx expo start --web  # or run in the browser at http://localhost:8081
```

Your phone and computer must be on the same Wi-Fi network. If that doesn't
work (on school or office networks, for example), use `npx expo start --tunnel`.

### 3. Headteachers, schools and coordinators

1. In Supabase, open **Authentication → Sign In / Providers** and turn **on**
   "Allow new users to sign up", and turn **off** "Confirm email" (the app
   checks the email itself with the 6-digit sign-in code, below).
2. In the app, a headteacher taps **New headteacher or supplier? Create an
   account**, picks **I'm a headteacher**, enters their name, email and a
   password, then **Set up your school**:
   the school's name, and optionally county and area. They are now its
   headteacher, and the dashboard lists the first steps.
3. Coordinators are added by the headteacher in **Staff → Add**, through the
   `manage-staff` Edge Function (creating a login needs the service role
   key, which must never be in the app):
   1. In Supabase, open **Edge Functions → Deploy a new function → Via Editor**.
   2. Name it `manage-staff`, paste the contents of
      `dsfmp-app/supabase/functions/manage-staff/index.ts` and deploy.
   3. In the function's settings, turn off **Verify JWT**. The function
      checks the signed-in user itself.

   The headteacher enters the coordinator's name, email and a temporary
   password; the coordinator chooses their own at their first sign-in. Tap
   someone in the list to suspend them (they can still sign in but see
   nothing) or set a new temporary password. To hand the school over, make a
   coordinator headteacher; they can then change your role.
4. Suppliers sign up the same way with **I'm a supplier**, then fill in
   **Set up your supplier account**. Fix 014 creates the private Storage
   bucket `supplier-documents` and its access rules; nothing else needs
   setting up. Use a different email from any school login.

### 4. Sign-in codes

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

### 5. Google sign-in

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
   To test Google sign-in in **Expo Go** on a phone, start Expo with
   `npx expo start --tunnel`. On the same Wi-Fi, Expo Go's address contains
   your computer's IP (`exp://192.168.x.x:8081/...`), and Supabase never
   redirects to IP addresses, so the phone lands on "localhost" instead. The
   tunnel gives a named address (`exp://…exp.direct`) that `exp://**` matches.
   The web app and installed builds (`dsfmp://`) aren't affected.
5. Keep **Allow new users to sign up** on (section 3): a new headteacher can
   start with Google too, and then sets up their school. A coordinator must
   use the Google account with the email their headteacher added; any other
   Google account becomes a new, separate headteacher account.

## Development notes

- Screens query Supabase directly (`supabase.from('table').select()`,
  `.insert()`, `.update()`). Permission rules live in the database's RLS
  policies, not in the app.
- Every school screen works on the user's school: get it with `useSchool()`
  and filter queries with `.eq('school_id', school.school_id)`. Send
  `school_id` when creating students; other tables fill it in automatically.
  Show or hide actions with `useSchool().can('permission')` (or
  `isHeadteacher`), matching the database's `has_school_permission()`.
  A new account sees `CreateSchoolScreen` until it has a school.
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
