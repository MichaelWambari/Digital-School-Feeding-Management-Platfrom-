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
3. Go to **Project Settings → API** and copy:
   - Project URL
   - `anon` public key
4. Paste them into `src/lib/supabase.ts`.

## 2. Create the Expo app
If you haven't already created the Expo project shell:
```bash
npx create-expo-app dsfmp-app
cd dsfmp-app
```
Then copy `App.tsx`, the `src/` folder, and `supabase/` folder from this
scaffold into your project, overwriting the default `App.tsx`.

## 3. Install dependencies
```bash
npx expo install @supabase/supabase-js @react-native-async-storage/async-storage react-native-url-polyfill
npx expo install @react-navigation/native @react-navigation/native-stack
npx expo install react-native-screens react-native-safe-area-context
```

## 4. Run it
```bash
npx expo start
```
Scan the QR code with the **Expo Go** app on your phone (Android/iOS), or
press `a` for the Android emulator / `i` for the iOS simulator.

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

## Next modules to build (uncomment in `AppNavigator.tsx` as you go)
- `BeneficiariesScreen` — list + add/edit form (UC-02 in your use case spec)
- `AttendanceScreen` — search beneficiary → record attendance
- `InventoryScreen` — stock list + add/update stock
- `DistributionScreen` — record distribution, auto-decrement inventory
- `ReportsScreen` — attendance/distribution summaries, maybe with a chart
  library like `react-native-chart-kit`

Each of these follows the same pattern as `DashboardScreen.tsx`: query
Supabase with `supabase.from('table_name').select()`, render the result,
and use `.insert()` / `.update()` for the forms.
