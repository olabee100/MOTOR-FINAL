# MotorTrack — Motor & Spares Control for the Mill

A real, deployable web app for tracking motors, spare parts (including spare
motors held in store), and breakdown/repair workflow across the mill floor,
the workshop, and outside vendors. Multiple people can log in at once with
different permissions, and the data lives in a real database on your server
— not just in a browser tab.

## What's inside

- **backend/** — Node.js + Express API, with a SQLite database (a single
  file, no separate database server to install or pay for).
- **frontend/** — the dashboard itself (plain HTML/CSS/JS, no build step).
  The backend serves it automatically, so once deployed you visit one URL
  and get the whole app.

## Accounts and permissions

Three roles:
- **Admin** — everything, plus creating/removing staff accounts.
- **Storekeeper** — manages spare parts and stock levels.
- **Technician** — manages motors and the breakdown/repair workflow.

Everyone can view everything; the role only limits who can *change* what.

The very first time the server starts, it automatically creates one admin
account using the username/password you set in `.env`. Log in with that,
then create real accounts for your team from the "Staff accounts" page and
change the admin password.

## Running it on your own computer first (recommended before deploying)

You'll need [Node.js](https://nodejs.org) installed (version 18 or newer).

```bash
cd backend
cp .env.example .env        # then open .env and set a real admin password
npm install
npm run seed                # adds sample motors & spares so you can try it
npm start
```

Open **http://localhost:4000** in your browser. Log in with the username/
password you put in `.env`.

To start fresh with no sample data, just delete `backend/db/motortrack.sqlite`
before running `npm start` — it will recreate an empty database (and the
first admin account) automatically. Skip `npm run seed` if you don't want
the sample motors and spares.

## Deploying so your team can use it

This needs to run somewhere that's on all the time — not your laptop. Two
realistic options, cheapest first:

### Option A — Render.com (~$7/month, easiest)

1. Push this whole `motortrack` folder to a GitHub repository.
2. On [render.com](https://render.com), create a **New Web Service**, point
   it at that repo, and set:
   - **Root directory:** `backend`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** the free tier will work for testing, but pick the
     cheapest **paid** tier ($7/mo Starter) before real use — the free tier
     sleeps when idle and can lose the database file on redeploys.
3. Under **Disks**, add a small persistent disk (1 GB is plenty) mounted at
   `/opt/render/project/src/backend/db` — this is what stops your motor and
   spares data from disappearing when the service restarts.
4. Under **Environment**, add the variables from `.env.example` (set a real
   `JWT_SECRET`, admin username/password, and SMS settings if you have them).
5. Deploy. Render gives you a free `https://yourapp.onrender.com` address —
   share that link with your team. A custom domain is optional and separate
   (~$10–15/year if you want one later).

### Option B — A small VPS (DigitalOcean, Contabo, etc., ~$5/month)

More setup work, but cheaper and fully under your control:

```bash
# on the server, after copying this project there:
cd backend
cp .env.example .env   # edit it with real values
npm install --production
npm run seed            # optional — remove if you don't want sample data
npm start
```

Use a process manager so it survives reboots and crashes:
```bash
npm install -g pm2
pm2 start server.js --name motortrack
pm2 save
pm2 startup   # follow the printed instructions
```

Put it behind Nginx with a free SSL certificate (via Certbot) if you want a
proper `https://` address instead of `http://server-ip:4000`.

## SMS alerts (optional, costs money per message)

Leave `SMS_PROVIDER=none` in `.env` and the app works fully — high-urgency
breakdowns are just written to the server log instead of texted out, at no
cost. When you're ready to pay for SMS:

1. Create a [Termii](https://termii.com) account (popular, Nigeria-friendly)
   and get an API key.
2. In `.env`, set `SMS_PROVIDER=termii`, `TERMII_API_KEY=...`, and
   `ALERT_PHONE_NUMBERS=2348012345678,2348023456789` (comma-separated,
   country code first, no plus sign or leading zero).
3. Restart the server. Every breakdown logged with **High** urgency will now
   text everyone on that list.

Want a different provider (Africa's Talking, Twilio, etc.) instead? The
code to send the message lives in one place — `backend/services/sms.js` —
and is written so a developer can add another provider there without
touching anything else.

## Running on Render's free tier

If you're starting on the free tier to save cost, know the tradeoff: **free
web services don't support persistent disks**, so the database resets to
empty (or to your seed data) every time the service restarts or redeploys —
which happens fairly often on free plans.

To make that survivable, the app has a built-in **Backup & Restore** panel
(Staff accounts page, admin only):
- **Download backup** — saves everything (motors, spares, breakdowns, staff
  accounts) as one JSON file to your computer.
- **Restore from backup** — uploads that file back in, replacing whatever
  is currently in the database.

On the free tier: download a backup regularly (daily if you're actively
using it), and especially right before you know a redeploy is coming (e.g.
after pushing new code). If the service resets, restore your latest backup
and you're back to where you were. It's manual and easy to forget — moving
to the $7/month Starter plan with a persistent disk removes this chore
entirely once the tool proves useful enough to justify the cost.

## What's new in this update

- **CSV import bug fixed** — quoted values (especially from your own exports) no longer carry literal quote marks through on import; proper CSV parsing now strips them correctly.
- **Filter Motors by kW, RPM, and Voltage**, alongside the existing search and department/status/location filters.
- **Spare motor swap workflow** — when a motor breaks down, you can now install a standby spare (new or repaired) in its place directly from the breakdown record. The spare comes off the standby list automatically, and the swap is logged in that breakdown's history — so you always know which physical motor is running where.
- **Reorder levels for Spare Motors** — set a minimum desired count for "New" and "Repaired" spare motors; the dashboard turns red when you're below it. Store location is shown per spare motor, and total count in each category doubles as your "qty in stock."
- **Motor status now includes "Under repair"** as its own explicit option (not just breakdown-driven), with a required **Internal workshop / External workshop** choice — feeding a dedicated **Under Repair dashboard**, split by workshop, with CSV export.
- **A motor can't break down twice at once** — enforced server-side now, not just hidden in the UI. Also can't report a breakdown on a motor that's standby or decommissioned.
- **Motor tags are enforced unique** — duplicate tag is rejected with a clear error, on single add, edit, and bulk/CSV import (which skips duplicates and tells you which ones).
- **Parts Inventory removed from the main nav** — Spare Motors is now the one editable, motors-only spares page (Add, Bulk add, Import CSV, Export CSV, Edit, Delete), reading and writing the same Motors data so it's automatically in sync everywhere.

## Previously added

- **Filtering & search everywhere** — Motors, Spare Motors, Parts Inventory, and Breakdowns all have search boxes that match across every relevant field, plus column filters (department, location type, status, category).
- **Checkboxes and bulk delete** — select multiple rows in any table and delete them all at once. Delete is now open to every signed-in role, not just admins.
- **CSV export** — every table has an "Export CSV" button that downloads exactly what's currently filtered/visible.
- **Print / Save as PDF** — on the Reports page, for a clean printable summary.
- **Full edit history (who / what / when)** — every motor, spare, and breakdown record now has a visible change log: who made each change, what changed, and the exact timestamp. See it in a motor's drawer, a spare's edit panel, or the "Recent activity" feed on Reports.
- **MTBF & MTTR** — Mean Time Between Failures and Mean Time To Repair, calculated automatically per motor (in its drawer) and fleet-wide (Reports page).
- **Spare Motors, properly categorized** — a dedicated page separate from Parts Inventory, for complete replacement motors: **New** (bought and held in store, never installed) vs **Repaired** (fixed and standing by in the workshop, ready to redeploy). Parts Inventory remains for consumables (bearings, belts, electrical parts, etc.).
- **Actual placement field** — when adding a motor, "Location type" (Mill floor / Workshop / Container / Store / Vendor / Other) is now paired with a free-text "Actual placement" field (e.g. "Bay 3", "Container 2, shelf B").
- **Motors are now rated in kW**, not HP.
- **Seamless breakdown editing** — you can move a breakdown through every stage, edit its details, add spares, and resolve it, all without the drawer closing or losing your place. (This fixes a real bug from the previous version where editing an item a second time after reopening it from a table row could silently fail.)
- **Required fields** — key fields (motor tag/name, spare name, breakdown description) can no longer be submitted empty.
- **No more login flash on reload** — refreshing the page while logged in no longer shows the login screen for a moment before returning you to the app.
- **Reopen a resolved breakdown** — if the same issue recurs, reopen the existing record instead of starting a new one.

## Backing up your data

Everything lives in one file: `backend/db/motortrack.sqlite`. Copy that file
somewhere safe on a schedule (even just emailing it to yourself weekly) and
you have a full backup of every motor, spare, and breakdown record.

## What this does not include

Being upfront, same as before: no ERP connection (SAP, Odoo, etc.) — that
would need to be built against whichever system you use, since every ERP's
integration method is different. If that becomes a priority, the cleanest
path is usually a scheduled export/import job or a webhook, and the REST
API here (`/api/motors`, `/api/spares`, `/api/events`) is already
structured so a developer can build that bridge without changing the app
itself.
