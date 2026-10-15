# DSFMP — Digital School Feeding Management Platform

A mobile app for running a school feeding programme: registering
beneficiaries, recording meal attendance (by hand or with NFC cards),
tracking food stock, issuing food, and reporting on all of it.

Built with **React Native (Expo)** and **Supabase** (PostgreSQL, Auth,
row-level security). Runs on Android, iOS and the web.

## Features

| Module | What it does |
|---|---|
| **Login** | Email/password sign-in with Supabase Auth. Sessions persist across app restarts. |
| **Dashboard** | Live beneficiary count, navigation to each module, and a light/dark/system theme switch. |
| **Beneficiaries** | Searchable list of learners with an add/edit form. |
| **Attendance** | Choose breakfast, lunch or supper and mark each active beneficiary present for today. Tap again to undo. Shows a present/total count and includes NFC scans. |
| **Inventory** | Stock list with low-stock warnings. Add or edit items and record deliveries (*received*) or usage (*used*). A database trigger keeps stock levels correct and blocks using more than is in stock. |
| **Distribution** | Pick a food item and portion size, then issue it to beneficiaries. Each issue deducts stock and is blocked if stock is short. |
| **Reports** | For today, the last 7 days or the last 30 days: meals served per meal with average attendance %, a daily attendance chart, food distributed per item, and current stock with low-stock items flagged. |
| **NFC scanning** | Card readers (e.g. an ESP32) call one database function, `record_nfc_scan()`, to record attendance or a distribution. Every scan is logged for audit. |

### Roles

Every user has one role, and the database enforces it with row-level security:

| Role | Can do |
|---|---|
| `admin` | Everything, including managing NFC devices and reading the NFC audit log |
| `coordinator` | Manage beneficiaries, record attendance, issue food, manage reports |
| `inventory_officer` | Manage inventory items and record stock movements |

All signed-in users can view beneficiaries, attendance, inventory,
distributions and reports.

### Meal serving windows

NFC attendance scans are filed under the meal whose window they fall in
(Africa/Nairobi time):

| Meal | Window |
|---|---|
| Breakfast | 06:00–07:00 |
| Lunch | 12:00–14:00 |
| Supper | 18:00–20:00 |

Scans outside every window are rejected with `outside_meal_time`. To change
the windows, edit `record_nfc_scan()` in `dsfmp-app/supabase/schema.sql`.

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
    screens/                One file per module (Login, Dashboard, Beneficiaries,
                            Attendance, Inventory, Distribution, Reports)
    theme/ThemeContext.tsx  Light/dark/system colours; use makeStyles + useThemedStyles
  supabase/
    schema.sql              Full database: tables, RLS policies, triggers, functions
    fixes/NNN_*.sql         Migrations for an existing database, run in number order
```

## Database

`dsfmp-app/supabase/schema.sql` creates these tables:

| Table | Purpose |
|---|---|
| `users` | Profile and role for each Supabase Auth user, created automatically on sign-up |
| `beneficiaries` | Learners in the programme, with their NFC tag IDs |
| `nfc_devices` | Registered card readers |
| `inventory_items` | Food items and current stock levels |
| `inventory_transactions` | Stock received or used. A trigger updates `inventory_items`. |
| `meal_attendance` | One row per beneficiary, meal and day |
| `food_distribution` | Food issued to beneficiaries. Stock is deducted automatically. |
| `reports` | Saved reports (export is planned) |
| `nfc_tag_logs` | Audit log of every NFC scan and its outcome |

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
with the role `coordinator`. To test another role, change `role` to `admin`
or `inventory_officer` in the Table Editor.

## Development notes

- Screens query Supabase directly (`supabase.from('table').select()`,
  `.insert()`, `.update()`). Permission rules live in the database's RLS
  policies, not in the app.
- Style screens with `makeStyles(c: Colors)` and `useThemedStyles` from
  `src/theme/ThemeContext.tsx` instead of hard-coding colours.
- Database changes must go in both places: edit `schema.sql`, and add a new
  `supabase/fixes/NNN_description.sql` that is safe to run on live data.
- Add native libraries with `npx expo install <package>` so their versions
  match the Expo SDK.

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

1. **M1: Stabilise & test.** End-to-end testing of each role, login errors on web, NFC error handling, and accurate attendance %.
2. **M2: Admin & reporting.** In-app user and role management, and PDF/CSV report export.
3. **M3: Operational flexibility.** Configurable meal windows and correcting mistaken distributions.
4. **M4: Release.** Production build and final documentation.
