# DSFMP — Digital School Feeding Management Platform (Mobile)

React Native (Expo) + Supabase starter matching your ERD, class diagram, and
use case diagram.

## 1. Create your Supabase project
1. Go to https://supabase.com → New project (free tier is fine).
2. Once created, open **SQL Editor** → paste the contents of
  `supabase/schema.sql` → Run. This creates the application tables
  (`users`, `beneficiaries`, `nfc_devices`, `inventory_items`,
  `inventory_transactions`, `meal_attendance`, `food_distribution`,
  `reports`, and `nfc_tag_logs`) with row-level security enabled.
  **Warning:** this development bootstrap drops and recreates these tables.
  Running it again deletes their data; do not use it to update a live database.
  To update an existing database instead, run the files in `supabase/fixes/`
  in number order. Each one is safe to run on live data, and `schema.sql`
  already includes them, so a fresh setup doesn't need them.
3. Go to **Project Settings → API** and copy:
   - Project URL
   - `anon` public key
4. Paste them into `src/lib/supabase.ts`.

## 2. Install prerequisites
- **Node.js LTS** (v20 or newer): https://nodejs.org (tick "Add to PATH")
- **Expo Go** app on your phone: App Store (iOS) / Google Play (Android)
- Optional: **Android Studio** (for the Android emulator), or a **Mac with
  Xcode** (for the iOS simulator). Neither is needed if you use Expo Go on a
  real phone.

This folder is already a complete Expo SDK 57 project (`package.json`,
`app.json`, `index.ts`, `tsconfig.json`, `assets/`), so you do **not**
need to run `create-expo-app`.

## 3. Install dependencies
```bash
npm install
```
(If you ever add a native library, use `npx expo install <package>` so the
version matches the Expo SDK.)

## 4. Run it
```bash
npx expo start
```
- **Android phone:** open Expo Go → *Scan QR code*.
- **iPhone:** scan the QR code with the Camera app → opens in Expo Go.
- Phone and computer must be on the same Wi-Fi. If that does not work (e.g.
  school/office network), run `npx expo start --tunnel`.
- Press `a` for the Android emulator, or `i` for the iOS simulator (Mac only).

Building installable apps (APK/AAB/IPA) later: use EAS Build
(`npm i -g eas-cli`, `eas build -p android` / `eas build -p ios`). iOS
builds for real devices need an Apple Developer account. The app identifiers
are set to `com.dsfmp.app` in `app.json`; change them before publishing.

## 5. Test the login flow
Since sign-up isn't wired up in the UI yet, create your first test user
directly in Supabase:
- Dashboard → Authentication → Users → **Add user** → enter an email/password.
- The `handle_new_user` trigger will automatically create a matching row in
  `users` with role `coordinator`. Change the role manually in the table
  editor if you want to test as `admin` or `inventory_officer`.
- Log in with those credentials in the app.

## What's built so far
- ✅ Supabase schema (matches Figure 4.3 ERD)
- ✅ Login screen (matches Figure 4.7 wireframe)
- ✅ Dashboard with live beneficiary count + navigation menu
- ✅ Auth-based routing (logged out → Login, logged in → Dashboard)
- ✅ Beneficiaries screen — searchable list + add/edit form (UC-02). Only
  `admin` and `coordinator` users can save; others see a permission error.
- ✅ Attendance screen — pick breakfast/lunch, search active beneficiaries,
  and mark each one present for today (tap again to undo). Shows a
  present/total count and picks up rows already recorded by NFC scans.
- ✅ Inventory screen — stock list with low-stock warnings, add/edit items,
  and record deliveries ("received") or usage ("used") per item with recent
  history. Stock levels are updated by a database trigger, which also blocks
  using more than is in stock. Only `admin` and `inventory_officer` users
  can make changes.
- ✅ Distribution screen — pick a food item and portion size, then issue it
  to beneficiaries (tap Issue, then Confirm). Each distribution
  automatically deducts stock and is blocked if stock is short. Shows who
  received the item today. Only `admin` and `coordinator` users can issue.

## Next modules to build (uncomment in `AppNavigator.tsx` as you go)
- `ReportsScreen` — attendance/distribution summaries, maybe with a chart
  library like `react-native-chart-kit`

Each of these follows the same pattern as `DashboardScreen.tsx`: query
Supabase with `supabase.from('table_name').select()`, render the result,
and use `.insert()` / `.update()` for the forms.
