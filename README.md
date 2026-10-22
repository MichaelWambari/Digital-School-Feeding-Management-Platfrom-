# DSFMP — Digital School Feeding Management Platform

A mobile app for running a school feeding programme: registering
beneficiaries, recording meal attendance (by hand or with NFC cards),
tracking food stock, issuing food, and reporting on all of it.

Built with **React Native (Expo)** and **Supabase** (PostgreSQL, Auth,
row-level security). Runs on Android, iOS and the web.

## Features

DSFMP serves a **network of schools**. Each school's students, readers, food
stock and records are kept separate, and staff only see their own school.

| Module | What it does |
|---|---|
| **Login** | Email/password sign-in with Supabase Auth. Sessions persist across app restarts. |
| **Dashboard** | The school's name, active beneficiary count and navigation to each module, plus a light/dark/system theme switch. Network admins choose which school to work on. |
| **Beneficiaries** | Searchable list of the school's learners with an add/edit form. |
| **Attendance** | Choose breakfast, lunch or supper and mark each active beneficiary present for today. Tap again to undo. Shows a present/total count and includes NFC scans. |
| **Inventory** | The school's stock list with low-stock warnings. Add or edit items and record deliveries (*received*) or usage (*used*). A database trigger keeps stock levels correct and blocks using more than is in stock. |
| **Distribution** | Pick a food item and portion size, then issue it to beneficiaries. Each issue deducts stock and is blocked if stock is short. |
| **Reports** | For today, the last 7 days or the last 30 days: meals served per meal with average attendance %, a daily attendance chart, food distributed per item, and current stock with low-stock items flagged. Network admins can switch between one school and all schools. |
| **NFC scanning** | Card readers (e.g. an ESP32) call one database function, `record_nfc_scan()`, to record attendance or a distribution. Each reader belongs to a school and only accepts that school's cards. Every scan is logged for audit. |

### Roles

Every user has one role, and the database enforces it with row-level security:

| Role | School | Can do |
|---|---|---|
| `network_admin` | All schools | Everything, at every school |
| `admin` | One school | Everything at their school, including managing NFC devices, meal times and reading the NFC audit log |
| `coordinator` | One school | Manage beneficiaries, record attendance, issue food, manage reports |
| `inventory_officer` | One school | Manage inventory items and record stock movements |

All staff can view their own school's beneficiaries, attendance, inventory,
distributions and reports.

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
    screens/                One file per module (Login, Dashboard, Beneficiaries,
                            Attendance, Inventory, Distribution, Reports)
    theme/ThemeContext.tsx  Light/dark/system colours; use makeStyles + useThemedStyles
  supabase/
    schema.sql              Full database: tables, RLS policies, triggers, functions
    fixes/NNN_*.sql         Migrations for an existing database, run in number order
    checks/health_check.sql Read-only check of structure, links and data (OK/WARN/FAIL)
    seed/demo_data.sql      Demo schools, students, readers, stock and a week of history
  scripts/simulate-reader.mjs  NFC reader simulator (npm run simulate)
```

## Database

`dsfmp-app/supabase/schema.sql` creates these tables:

| Table | Purpose |
|---|---|
| `schools` | Schools in the network, with each school's timezone and meal serving windows |
| `users` | Profile, role and school for each Supabase Auth user, created automatically on sign-up |
| `beneficiaries` | Learners at each school, with their NFC tag IDs |
| `nfc_devices` | Registered card readers, each at one school |
| `inventory_items` | Each school's food items and current stock levels |
| `inventory_transactions` | Stock received or used. A trigger updates `inventory_items`. |
| `meal_attendance` | One row per beneficiary, meal and day |
| `food_distribution` | Food issued to beneficiaries. Stock is deducted automatically. |
| `reports` | Saved reports (export is planned) |
| `nfc_tag_logs` | Audit log of every NFC scan and its outcome |

Every table except `schools` has a `school_id`. Attendance, distributions and
stock movements take theirs automatically from the beneficiary or item, so a
record can't end up filed under the wrong school. `nfc_tag_logs` deliberately
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
   test students and NFC card IDs, a registered reader, food stock, and a week
   of past attendance and lunch distributions, plus a reader for Jasiri
   School. It only adds missing rows, so it's safe to run again or on a live
   database.

### 2. Install and run

```bash
cd dsfmp-app
npm install
npx expo start        # then scan the QR code with Expo Go
npx expo start --web  # or run in the browser at http://localhost:8081
```

Your phone and computer must be on the same Wi-Fi network. If that doesn't
work (on school or office networks, for example), use `npx expo start --tunnel`.

### 3. Create users

There is no sign-up screen yet, so create users in Supabase under
**Authentication → Users → Add user**. A trigger adds a matching `users` row
with the role `coordinator` and no school. In the Table Editor, open `users`
and:

- set `school_id` to the user's school (from the `schools` table), and
- change `role` if needed: `admin`, `inventory_officer`, or `network_admin`
  (who doesn't need a school).

Until a user has a school, the app shows them a "not assigned to a school"
message. A new database starts with one school, **Jasiri School**. Add more
schools as rows in the `schools` table.

## Development notes

- Screens query Supabase directly (`supabase.from('table').select()`,
  `.insert()`, `.update()`). Permission rules live in the database's RLS
  policies, not in the app.
- Every screen works on one school: get it with `useSchool()` and filter
  queries with `.eq('school_id', school.school_id)`. Send `school_id` when
  creating beneficiaries and inventory items; other tables fill it in
  automatically.
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
npm run simulate -- --device reader-upendo-01 --tag B2000001 --mode distribution --item <item_id> --quantity 0.25
npm run simulate -- --help
```

Attendance taps only succeed inside the school's meal windows; outside them
the result is `outside_meal_time`. The item ID for distribution is the
`item_id` in the `inventory_items` table. Add `--json` to get one JSON line
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
