# Flight Log — setup guide

A private drone flight log for A2 CofC record-keeping: login, a dashboard,
a pre-flight checklist built into the flight form, a flight entry form with
auto-fill, a flight log with date-range filtering and CSV export, and
drone/battery/controller hour and cycle tracking. Runs entirely on free
tiers: GitHub Pages (hosting) + Firebase Spark plan (login + database).

## What's new in this version

- **Dashboard** — lands here after login. Shows each drone's airframe hours
  and cycles, its controller's hours and cycles, each battery's hours and
  cycles, overall totals, and your 5 most recent flights.
- **Pre-flight check, built into the New Flight page** — sits at the top of
  the form and must be completed (or explicitly skipped) before the rest of
  the flight fields unlock. Covers all 4 propellers and all 4 arms
  individually (Front Left/Right, Back Left/Right), the gimbal/thermal lens,
  night beacon (only shown if you tick "flying at night"), landing zone, and
  a full hazard sweep grouped into Airborne & Airspace, Ground & Physical
  Obstacles, Signal & Environmental Interference, and People & Mobile
  Hazards — plus a free-text "other hazard" box. A "Copy Last Check" button
  reuses your previous check as a starting point. If you type a what3words
  address you've flown from before, the hazard sweep and landing zone notes
  from your last check at that exact location prefill automatically (still
  editable — it's a starting point, not a shortcut past actually looking).
- **Hours and cycles now track properly.** When you add a drone or battery,
  you're asked for its starting hours/cycles (so equipment you already used
  before starting this log isn't counted as brand new). Every logged flight
  then adds its duration and +1 cycle to the drone, its controller, and
  whichever battery you picked.
- **Flight Log now has date-range filtering** — a From/To picker plus quick
  buttons (Last 30 days, Last 90 days, This year, All time). The table, the
  hours total shown, and the CSV export all respect whatever range is
  selected, and the exported filename includes the date range.

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com and click **Add project**.
   Give it any name (e.g. "drone-flight-log"). You can decline Google
   Analytics — not needed.
2. Stay on the free **Spark plan** — do not upgrade to Blaze. Nothing here
   needs it.
3. In the left sidebar: **Build > Authentication** > Get started > enable
   the **Email/Password** sign-in method.
4. Still in Authentication, go to the **Users** tab and click **Add user**.
   Create the one account you'll log in with (your email + a password).
   This site has no public sign-up page — you are the only user there will
   ever be.
5. In the left sidebar: **Build > Firestore Database** > Create database >
   start in **production mode** > pick any region close to you.
6. Once created, go to the **Rules** tab and replace the contents with the
   `firestore.rules` file included here, then click **Publish**.
7. Go to **Project settings** (gear icon, top left) > scroll to **Your apps**
   > click the `</>` (web) icon > register an app (any nickname) > it will
   show you a `firebaseConfig` object.
8. Open `firebase-config.js` in this folder and paste your real values in
   place of the `YOUR_...` placeholders.

## 2. (Optional) what3words API key

This powers the location/weather auto-fill. Skip this step if you're happy
typing weather in manually — everything still works without it.

1. Go to https://what3words.com/select-plan and sign up for the free
   **Lite** API plan.
2. Get your API key from the developer dashboard.
3. Paste it into `firebase-config.js` as `w3wApiKey`.

Weather itself comes from Open-Meteo, which needs no API key at all.

## 3. Put it on GitHub Pages

1. Create a new **public** repository on GitHub (e.g. `flight-log`).
2. Upload all the files in this folder (`index.html`, `app.html`, `app.js`,
   `styles.css`, `firebase-config.js`, `firestore.rules`) to the repo —
   easiest is dragging them into the GitHub web UI's "Add file > Upload
   files", or via git if you're comfortable with it.
3. In the repo, go to **Settings > Pages**, set the source to the `main`
   branch and root folder, and save.
4. GitHub gives you a URL like `https://yourusername.github.io/flight-log/`
   — that's your site. It can take a minute to go live the first time.

Note: the repo needs to be public for free GitHub Pages hosting, and your
Firebase config values will be visible in it — that's normal and safe, since
they just identify your project rather than being secret keys. Your actual
protection is the Firestore rule (only a logged-in user can read/write) plus
the fact that there is no sign-up page, so nobody else can ever create an
account to log in with.

## 4. Using it

- Open your GitHub Pages URL, log in with the one account you created in
  step 1.4.
- First thing to do: go to **Batteries & Drones** and add your drone (model,
  aircraft serial, controller serial) and its batteries.
- Then use **New Flight** to log flights — pick your drone, its serial
  auto-fills, pick a battery, fill in date/times (duration calculates
  itself), and optionally a what3words address (weather auto-fills if you
  added an API key).
- **Flight Log** shows everything you've logged, with a running total and a
  CSV export button.

## Files in this folder

- `index.html` — login page
- `app.html` — the app itself (all three views, switched by the sidebar)
- `app.js` — all the logic (Firebase reads/writes, auto-fill, CSV export)
- `styles.css` — shared styling
- `firebase-config.js` — **you edit this** with your project's config and
  (optionally) your what3words key
- `firestore.rules` — paste into the Firebase console's Firestore rules tab
