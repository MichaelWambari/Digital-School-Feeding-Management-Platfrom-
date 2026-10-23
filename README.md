# DSFMP — Digital School Feeding Management Platform

A mobile app for running a school feeding programme: registering
students, recording meal attendance (by hand or with NFC cards), moving
food from a central store to schools, recording the food each meal uses,
and reporting on all of it.

Built with **React Native (Expo)** and **Supabase** (PostgreSQL, Auth,
row-level security). Runs on Android, iOS and the web.

## Features

DSFMP serves a **network of schools**, supplied with food from a **central
store** run by the network admin. Each school's students, readers, food stock
and records are kept separate, and school staff only see their own school.

Food moves like this:

```
supplier ──delivery──► central store ──dispatch──► school store ──food used──► breakfast / lunch / supper
```

| Module | What it does |
|---|---|
| **Login** | Email/password sign-in with Supabase Auth. Sessions persist across app restarts. |
| **Dashboard** | The school's name, active student count and navigation to each module, plus a light/dark/system theme switch. Network admins choose which school to view. |
| **Students** | Searchable list of the school's students with an add/edit form. View only for network admins. |
| **Attendance** | Choose breakfast, lunch or supper and mark each active student present for today. Tap again to undo. Shows a present/total count and includes NFC scans. View only for network admins. |
| **Inventory** | *Network admin:* the central store. Keep the network's food list, record deliveries from suppliers and write-offs, with low-stock warnings. *School staff:* the school's stock, with low-stock warnings, a per-food reorder level and the history of food received and used. A database trigger keeps every stock level correct and blocks using more than is in stock. |
| **Distribution** | *Network admin:* dispatch food from the central store to a school (cancel it while it's still in transit), and see for every school how much of each food was sent, how much was used and how much is in stock. *School staff:* confirm deliveries from the central store with the amount that actually arrived (any shortfall is recorded), and after each meal record how much of each food was used. The app shows the portion per student from that meal's attendance. |
| **Reports** | For today, the last 7 days or the last 30 days: meals served per meal with average attendance %, a daily attendance chart, food used per item, and current stock with low-stock items flagged. Network admins can switch between one school and all schools. |
| **Staff** | *Network admin only:* create staff logins and give each a role and school, move staff between schools, suspend or restore them, and reset passwords. |
| **NFC scanning** | Card readers (e.g. an ESP32) call one database function, `record_nfc_scan()`, to record a student's attendance at the current meal. Each reader belongs to a school and only accepts that school's cards. Every scan is logged for audit. |

### Roles

Every user has one role, and the database enforces it with row-level security:

| Role | School | Can do |
|---|---|---|
| `network_admin` | All schools | Run the central store and the food list, dispatch food to schools, manage staff, schools and NFC readers, and view every school's records. Can't change a school's students, attendance, stock or food used. |
| `admin` | One school | Everything at their school, including managing NFC devices, meal times and reading the NFC audit log |
| `coordinator` | One school | Manage students, record attendance and food used, manage reports |
| `inventory_officer` | One school | Confirm deliveries, record food used and set reorder levels |

All staff can view their own school's students, attendance, stock, deliveries,
food used and reports.

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

- **App:** Expo SDK 57, React Native 0.86, React 19, TypeScript, React Navigation
- **Backend:** Supabase: PostgreSQL, Auth, row-level security, triggers and `security definer` functions
- **Hardware (optional):** NFC readers that call the `record_nfc_scan` RPC over HTTPS

## Project structure

```
dsfmp-app/                  The Expo app (run all commands from here)
  App.tsx                   App entry: theme provider + navigator
  src/
    lib/supabase.ts         Supabase client (project URL + anon key)
    navigation/             Auth-based routing (logged out → Login)
    school/SchoolContext.tsx  Signed-in user's profile and current school; use useSchool()
    screens/                One file per module (Login, Dashboard, Students,
                            Attendance, Inventory, Distribution, Reports, Staff); the
                            network admin's Inventory and Distribution are
                            CentralStoreScreen and NetworkDistributionScreen
    theme/ThemeContext.tsx  Light/dark/system colours; use makeStyles + useThemedStyles
  supabase/
    schema.sql              Full database: tables, RLS policies, triggers, functions
    fixes/NNN_*.sql         Migrations for an existing database, run in number order
    checks/health_check.sql Read-only check of structure, links and data (OK/WARN/FAIL)
    seed/demo_data.sql      Demo schools, students, readers, stock and a week of history
    functions/manage-staff/ Edge Function that creates staff logins and resets passwords
  scripts/simulate-reader.mjs  NFC reader simulator (npm run simulate)
  firmware/wokwi/           ESP32 reader firmware, runnable in the Wokwi simulator
```

## Database

`dsfmp-app/supabase/schema.sql` creates these tables:

| Table | Purpose |
|---|---|
| `schools` | Schools in the network, with each school's timezone and meal serving windows |
| `users` | Profile, role and school for each Supabase Auth user, created automatically on sign-up |
| `beneficiaries` | Students at each school, with their NFC tag IDs |
| `nfc_devices` | Registered card readers, each at one school |
| `food_items` | The network's food list (name, unit) and the central store's stock of each food |
| `central_transactions` | Central store movements: deliveries, write-offs, dispatches and cancelled dispatches. A trigger updates `food_items`. |
| `food_distribution` | Dispatches from the central store to a school: in transit, received (with the amount that arrived) or cancelled |
| `inventory_items` | Each school's stock of each food it has received |
| `food_consumption` | Food a school used at one meal on one day |
| `inventory_transactions` | School stock received from the central store or used at meals. A trigger updates `inventory_items`. |
| `meal_attendance` | One row per student, meal and day |
| `reports` | Saved reports (export is planned) |
| `nfc_tag_logs` | Audit log of every NFC scan and its outcome |

Every school record has a `school_id`. Attendance, food used and stock
movements take theirs automatically from the student or item, so a record
can't end up filed under the wrong school. Stock never changes directly:
dispatching (`food_distribution`), confirming a delivery
(`receive_distribution()`), cancelling one (`cancel_distribution()`) and
recording food used each add a transaction, and triggers keep the stock
levels in step. Staff are listed and edited with `list_staff()` and
`update_staff()` (network admins only). In the database, students are still called
`beneficiaries`. `nfc_tag_logs` deliberately
has no foreign keys on the card and reader, so scans from unknown cards or
unregistered readers are still recorded.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) LTS, v20 or newer
- A [Supabase](https://supabase.com) project (the free tier is fine)
- [Expo Go](https://expo.dev/go) on your phone, or an Android emulator / iOS simulator

### 1. Set up the database

1. In your Supabase project, open the **SQL Editor**, paste the contents of
   `dsfmp-app/supabase/schema.sql`, and run it.
2. Copy the **Project URL** and **anon/publishable key** from
   **Project Settings → API** into `dsfmp-app/src/lib/supabase.ts`.

> **Warning:** `schema.sql` is a bootstrap script. It **drops and recreates**
> the tables, so running it on a live database deletes their data. To update
> an existing database, run the files in `dsfmp-app/supabase/fixes/` in number order
> instead. `schema.sql` already includes every fix, so a new database doesn't
> need them.

3. Optional: run `dsfmp-app/supabase/seed/demo_data.sql` to load demo data.
   It adds three more schools (Tumaini, Upendo and Baraka), each with
   test students and NFC card IDs, a registered reader, food received from
   the central store, and a week of past attendance and food used at meals,
   plus a reader for Jasiri School. It also stocks the central store and
   leaves one rice delivery to Tumaini in transit, ready to confirm. It only
   adds missing rows, so it's safe to run again or on a live database.

### 2. Install and run

```bash
cd dsfmp-app
npm install
npx expo start        # then scan the QR code with Expo Go
npx expo start --web  # or run in the browser at http://localhost:8081
```

Your phone and computer must be on the same Wi-Fi network. If that doesn't
work (on school or office networks, for example), use `npx expo start --tunnel`.

### 3. Create the first network admin

1. In Supabase, go to **Authentication → Users → Add user → Create new
   user**. Enter an email and password and tick **Auto Confirm User**. A
   trigger adds a matching `users` row with the role `coordinator` and no
   school.
2. Make that user a network admin in the **SQL Editor**:

   ```sql
   update public.users u set role = 'network_admin', school_id = null
   from auth.users a
   where a.id = u.user_id and a.email = 'you@example.com';
   ```

A new database starts with one school, **Jasiri School**. Add more schools as
rows in the `schools` table.

### 4. Staff accounts

Everyone else is added from the app's **Staff** screen, which only network
admins see. It needs the `manage-staff` Edge Function, because creating a
login takes the service role key, which must never be in the app:

1. In Supabase, open **Edge Functions → Deploy a new function → Via Editor**.
2. Name it `manage-staff`, paste the contents of
   `dsfmp-app/supabase/functions/manage-staff/index.ts` and deploy.
   Supabase gives the function its URL and service role key automatically.
3. In the function's settings, turn off **Verify JWT**. The function checks
   the signed-in user itself and only accepts active network admins.

Then, signed in as a network admin, open **Staff → + Add**. Enter the
person's name, email and a password, choose their role and school, and tap
**Create login**. Give them the email and password, and they can sign in
straight away. Tap someone in the list to change their role or school,
suspend them (they can still sign in but see nothing) or set a new password.

Without the Edge Function you can still add users by hand: create them as
in step 3, then set their `role` and `school_id` in the `users` table. Until
a user has a school, the app shows them a "not assigned to a school" message.

## Development notes

- Screens query Supabase directly (`supabase.from('table').select()`,
  `.insert()`, `.update()`). Permission rules live in the database's RLS
  policies, not in the app.
- Every screen works on one school: get it with `useSchool()` and filter
  queries with `.eq('school_id', school.school_id)`. Send `school_id` when
  creating students and dispatches; other tables fill it in automatically.
  Inventory and Distribution show a different screen to network admins
  (`useSchool().isNetworkAdmin`).
- Style screens with `makeStyles(c: Colors)` and `useThemedStyles` from
  `src/theme/ThemeContext.tsx` instead of hard-coding colours.
- Database changes must go in both places: edit `schema.sql`, and add a new
  `supabase/fixes/NNN_description.sql` that is safe to run on live data.
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
