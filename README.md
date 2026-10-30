# HUPHUP invoer

An entry sheet where staff and invited guests sign in with Microsoft and enter, per club and daypart (VM/NM), these numbers (whole numbers 0–99, all 0 by default):

| Code | Field |
|---|---|
| L | Aantal opportunities |
| C | Aantal belgesprekken |
| A | Aantal gemaakte afspraken |
| AM | Afspraken gemaakt door Milo |
| P | Aantal presentaties gegeven |
| I | Aantal inschrijvingen |
| IO | IO |
| R | Gescoorde referenties |
| B | Benfit |
| F | Posts op sociale media |
| PL / PA / PI | Pelvi lead / afspraak / inschrijving — **only for Zandhoven** |

The list lives in `fields.js`. To add a field, add a line there and redeploy; the database column is created automatically. Pelvi fields are stored as empty (NULL) for other clubs, and they only appear on screen when a Zandhoven club is chosen.

- **Login:** your own Entra tenant only. Members and invited guests can sign in (guests without a Microsoft account get an email code). Everyone in your tenant (members and invited guests) can use it straight away; there is no per-person approval.
- **Rules:** the server enforces them in Belgian time.
  - VM opens at 11:00 and NM at 18:00.
  - Future dayparts and anything older than 30 days are refused.
  - Each score is an integer from 0 to 100.
- **Default club:** taken from the *Office location* field (or *Department*) on the user in Entra. If that is empty, the club the user used last is the default.
- **One entry per person per daypart:** this applies whatever the club. The database enforces it. In the form, dayparts already filled in show a ✓ and can't be picked again, and the quick entry jumps to the newest open daypart.
- **One club list:** the clubs come from the GHL agency dashboard (its `subaccounts.csv` secret file), through the dashboard's `/clubs.json`, which returns names and LocationIds only, never tokens. A new sub-account in the dashboard shows up in the form within an hour. The last known list is kept in the database, so the form keeps working while the dashboard is asleep or redeploying. Each entry stores both the club name and its GHL LocationId.
- **Storage:** a Postgres database on Render. Each person sees and edits only their own entries. The people in `ADMIN_EMAILS` can download all entries as CSV.

## 1. Entra: app registration

In the Entra admin centre, go to **App registrations → New registration**.

1. **Register the app.**
   - Name: `HUPHUP invoer`.
   - Supported account types: **Accounts in this organizational directory only**.
   - Redirect URI: platform **Single-page application (SPA)**, value `https://<your-service>.onrender.com/`. You can add this after step 3 once you know the URL. For local testing, also add `http://localhost:3000/`.
2. Note the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Expose an API.**
   - Set the Application ID URI to `api://<client-id>`.
   - **Add a scope** named `access_as_user`. Who can consent: *Admins and users*. Fill in a display name such as "Invoer opslaan".
4. **Add API permissions.** Go to **API permissions → Add a permission** and add:
   - **My APIs → HUPHUP invoer → access_as_user**
   - **Microsoft Graph → Delegated → User.Read** (this one is usually already there)

   Then click **Grant admin consent**, so nobody, including guests, gets a consent screen.
5. **(Optional) Use v2 tokens.** In **Manifest**, set `"requestedAccessTokenVersion": 2`. The server accepts v1 and v2 tokens either way.

## 2. Entra: who may sign in

1. **Open to the whole tenant.** Go to **Enterprise applications → HUPHUP invoer → Properties** and leave **Assignment required** on **No** (the default). Every member and invited guest of your tenant can then sign in without anyone approving them. (If you ever want to limit it, set it to Yes and assign a group under **Users and groups**.)
2. **Invite guests.** For external people, use **Users → Invite external user**, or **Bulk invite** with a CSV.
3. **Check guest login.** Under **External Identities → All identity providers**, make sure **Email one-time passcode** is on.
4. **Set default clubs.** Per user, fill in **Office location** with the exact club name as the dashboard shows it, for example `Hoogstraten`. This works for guests too.

## 3. Render

1. **Push this folder to a GitHub repository.**
2. **Create the Blueprint.** In Render, go to **New → Blueprint**, pick the repo, and Render reads `render.yaml`. It creates:
   - the web service, on the *Starter* plan so it doesn't sleep;
   - the Postgres database, on the *Basic* plan, because the free database is deleted after 30 days.
3. **Fill in the environment variables:**

   | Variable | Value |
   |---|---|
   | `TENANT_ID` | Directory (tenant) ID |
   | `CLIENT_ID` | Application (client) ID |
   | `DASHBOARD_URL` | Address of your **ghl-agency-dashboard** service, e.g. `https://ghl-agency-dashboard-xxxx.onrender.com` |
| `DASHBOARD_KEY` | The dashboard's `CLUBS_KEY` (a separate key just for the club list; see the dashboard README) |
| `EXCLUDE_CLUBS` | Optional. Sub-accounts in the dashboard that aren't clubs, comma-separated, e.g. `Fysioworld,huphup leeg` |
   | `ADMIN_EMAILS` | Who may export, for example `karl.peeters@huphup.be` |
| `EXTRA_FIELD_CLUBS` | Optional. Part of the club name that gets the Pelvi fields; default `Zandhoven` |

   `DATABASE_URL` is filled in automatically.
4. **Add the redirect URI.** After the first deploy, add the service URL (with a trailing `/`) as the SPA redirect URI from step 1.1.

The tables are created automatically at the first start (`schema.sql`).

## Local testing

```bash
npm install
export TENANT_ID=… CLIENT_ID=… ADMIN_EMAILS=karl.peeters@huphup.be
export DASHBOARD_URL=https://ghl-agency-dashboard-xxxx.onrender.com DASHBOARD_KEY=…
# or, without the dashboard: export CLUBS="Hoogstraten,Zandhoven"
export DATABASE_URL=postgres://user:pass@localhost:5432/huphup_invoer
npm start          # http://localhost:3000
npm test           # checks the daypart rules
```

## API

All calls need `Authorization: Bearer <token for api://<client-id>/access_as_user>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Clubs, available dayparts, today (Belgian time), user |
| GET | `/api/entries` | Your own entries from the last 30 days |
| POST | `/api/entries` | `{club, date:"YYYY-MM-DD", part:"VM"\|"NM", L, C, A, AM, P, I, IO, R, B, F, PL, PA, PI}`; missing numbers count as 0 |
| PUT | `/api/entries/:id` | Same body; only your own rows |
| DELETE | `/api/entries/:id` | Only your own rows |
| GET | `/api/export.csv` | Entries as CSV, for people with CSV-export: club managers get only their own clubs, global managers all clubs; semicolon-separated for Excel |

## Data in Excel

**One-off:** people listed in `ADMIN_EMAILS` (comma-separated, e.g. `karl.peeters@huphup.be,collega@huphup.be`) see **Export (CSV)** at the top of the form.

**Live sheet that refreshes:**
1. On Render, open **huphup-invoer → Environment**, add `EXPORT_KEY`, click **Generate**, then **Save changes**.
2. Your link is `https://huphup-invoer.onrender.com/export.csv?key=<EXPORT_KEY>`. Test it in a browser: it downloads the CSV.
3. In Excel, go to **Data → From Web** (Gegevens → Van het web), paste the link and click **OK**. If Excel asks how to connect, choose **Anonymous** (the key in the link is the protection).
4. In the preview, check that the delimiter is **Semicolon**, then click **Load**.
5. To update: **Data → Refresh All**. For automatic refresh, go to **Data → Queries & Connections**, right-click the query, choose **Properties**, and tick *Refresh data when opening the file* and/or *Refresh every … minutes*.

Anyone with the full link can read all entries. Keep the link and the Excel file private. If it leaks, generate a new `EXPORT_KEY` on Render and paste the new link into Excel (**Data → Queries & Connections → right-click → Edit → Source**).

## Results page for managers

Managers sign in as usual. A **Resultaten** link then appears at the top of the form; it opens `/resultaten.html`.

- **Club managers** see their own clubs: per club, per employee and per month, with drilldowns. They only receive the shifts entered for their own clubs — also for a coach who works in several clubs, only the shifts in the manager's clubs. Other clubs are reduced on the server to summary figures (all-clubs totals for the averages, and the lowest/highest value per column for the bars); no rows from other clubs reach their browser, not even anonymised. The only thing they learn about another club is its name, in the note *"Werkte deze maand ook in …"* under a coach of theirs who also worked elsewhere that month; no figures from that club.
- **Global managers** see every club and every person.

## KPI page (Control+ members and revenue)

Managers also get a **KPI** link (next to *Resultaten*); it opens `/kpi.html`. It shows, per club and per month,
the Control+ figures: clients at the start and end of the month, growth, new, renewed, stopped and blocked
clients, revenue, and (from Dataverse) visits, unique visitors and active % (unique visitors ÷ clients at end), and (from Net2, daily) badge-bezoeken and badge-bezoekers: card entries by members of "HUPHUP <club> - klanten". Hover over a revenue amount to see the payment methods. Two tabs: **Per club** (one month)
and **Per maand** (the last 12 months for the chosen club or all your clubs together).

- **Where the numbers come from:** the **cplus-report** service (the Control+ scraper on Render), through its
  `/api/data` endpoint. This app doesn't log in to Control+ itself.
- **Who sees what:** the same rule as Resultaten. Club managers get their own clubs only, plus one
  *Alle clubs* total per month for comparison; global managers see every club.
- **Club names** are matched with the dashboard list, ignoring upper/lower case and a leading "HUPHUP".
- **Setup:** on Render, add `CPLUS_URL` (address of the cplus-report service) and `CPLUS_KEY` (its `API_KEY`).
  Without them the KPI link stays hidden.

API: `GET /api/kpi` (signed in, managers only).

## Importing history

Registrations made before this app (e.g. the old *rapportages* CSV) are loaded on the **Beheer** page, under **Historiek importeren**:

1. **Choose the CSV.** Columns: `email;afzender;gepost;datum;dagdeel;club;L;C;A;P;I;R;F`. Separators `;` or `,` both work. Dates can be `d/mm/yyyy` or `yyyy-mm-dd`. Empty numbers count as 0.
2. **Check the trial run.** You see the number of rows, coaches, period and rows per club, plus what is left out. Nothing is saved yet.
3. **Click "Importeer …"** to save.

**Rules:**
- **One entry per person per daypart stays.** If a coach sent several reports for the same daypart, also for different clubs, only the one posted last is imported. The page lists the others.
- **No duplicates.** Dayparts already in the app for that person (entered there, or imported earlier) are skipped, so importing the same file twice adds nothing.
- **Club names.** These are matched with the dashboard list, ignoring upper/lower case and a leading "HUPHUP". Unknown clubs are reported and skipped.
- **Linking to accounts.** Old rows are not yet linked to a Microsoft account. They are stored under the coach's e-mail address. The first time that coach signs in, they move to their account automatically. If the coach already entered that daypart in the app, their own entry wins.

API: `POST /api/admin/entries.csv` (header `x-api-key: <ADMIN_API_KEY>`, CSV text as body). Add `?dryrun=1` for the trial run only.

## Beheer page (managers, admins, owners)

Admins and owners see a **Beheer** link; it opens `/beheer.html`. Per person:

| Setting | Meaning |
|---|---|
| Ziet in Resultaten | Clubmanager (with clubs), Globale manager, or Niets |
| CSV-export | May download the entries as CSV, only for the clubs they see. On by default |
| Admin | May use the Beheer page and manage managers |
| Owner | Admin who can also give and take admin and owner rights |

Rules, enforced by the server: there is always at least one owner and one admin (an owner counts as admin); only owners change admin/owner rights or remove an admin or owner.

**First start:** the list is read once from the `managers.csv` Secret File (or the `MANAGERS` variable), and the addresses in `ADMIN_EMAILS` become owners. After that, the list lives in the database and is managed on the Beheer page; the Secret File is no longer needed. `ADMIN_EMAILS` remains a safety net: if no owner exists at all, those addresses are treated as owners.

**CSV:** "Download lijst" gives `email;rol;clubs;csv;admin;owner`. "Importeer CSV" accepts that format or simply `email;club` / `email;global` per line. With "Import vervangt de huidige managers", people not in the file lose their manager role (admins and owners keep their admin rights).

**API** (for scripts or Power Automate), header `x-api-key: <ADMIN_API_KEY>`; acts as an admin, never as an owner:

| Method | Path | |
|---|---|---|
| GET | `/api/admin/people` | the list |
| PUT | `/api/admin/people/{email}` | `{"scope":"club","clubs":["Schoten"],"can_export":true}` — add or change |
| DELETE | `/api/admin/people/{email}` | remove |
| GET | `/api/admin/people.csv` | list as CSV |
| POST | `/api/admin/people.csv` (`?replace=1`) | CSV text as body |
