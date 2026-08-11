# Learning Ledger

A learning progress tracker with admin and learner profiles. Admins create
trainings with a lesson plan (topics + expected completion dates) and enroll
learners; learners check off topics as they finish them. Status (On Track /
In Progress / Delayed) is calculated automatically, and anything more than
50% behind schedule is flagged as Delayed.

Data is stored in Supabase (Postgres) and syncs live — an admin adding a
training shows up for learners without a page refresh.

## 1. Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up — email/password or GitHub login both work, no Google account needed.
2. Click **New project**. Pick any name and region, set a database password (save it somewhere, you likely won't need it again), and wait ~2 minutes for it to provision.
3. Once it's ready, open the **SQL Editor** (left sidebar) and run this once, exactly as written:

   ```sql
   create table learning_ledger_data (
     key text primary key,
     value jsonb not null default '[]'::jsonb,
     updated_at timestamptz not null default now()
   );

   alter table learning_ledger_data enable row level security;

   create policy "Allow read" on learning_ledger_data for select using (true);
   create policy "Allow insert" on learning_ledger_data for insert with check (true);
   create policy "Allow update" on learning_ledger_data for update using (true);

   alter publication supabase_realtime add table learning_ledger_data;
   ```

   This creates the one table the app uses, and turns on live sync for it.

4. Go to **Project settings → API**. You'll need two values from this page:
   - **Project URL**
   - **anon public** key (under Project API keys — not the `service_role` one)

### Security note

The policies above allow anyone with your Supabase URL and anon key to
read and write this table — that's what lets the app's simple, no-password
login work with zero setup. It also means anyone with the link can see and
edit all data. Fine for an internal team tool; if you need real access
control later (so only invited people can log in), the next step is adding
Supabase Auth — ask me if you want that built in.

### One thing to know about the free tier

Free Supabase projects **pause automatically after 7 days with no activity**
(any request wakes it up again with a click in the dashboard, no data is
lost). If this tool will sit unused for stretches between training cohorts,
keep that in mind — otherwise it's a non-issue for regular use.

## 2. Push this project to GitHub

```bash
cd learning-insights
git init
git add .
git commit -m "Initial commit"
gh repo create learning-insights --public --source=. --push
# or, without the GitHub CLI:
# create a repo named learning-insights on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/learning-insights.git
git branch -M main
git push -u origin main
```

## 3. Add your Supabase values as GitHub secrets

In your new repo on GitHub: **Settings → Secrets and variables → Actions →
New repository secret**. Add both of these, using the values from step 1.4:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## 4. Turn on GitHub Pages

**Settings → Pages → Build and deployment → Source → GitHub Actions.**

That's it — the included workflow (`.github/workflows/deploy.yml`) builds
and deploys automatically on every push to `main`. Check the **Actions** tab
for progress; when it finishes, your app is live at:

```
https://YOUR_USERNAME.github.io/learning-insights/
```

Anyone with that link can open it, pick a profile (or create the first
admin account), and start using it.

## Local development (optional)

```bash
npm install
cp .env.example .env.local   # fill in your Supabase values
npm run dev
```

## What's in here

- `src/App.jsx` — the whole app (UI, status/delay logic, all views)
- `src/supabase.js` — Postgres read/write + live-sync layer
- `.github/workflows/deploy.yml` — auto build & deploy to GitHub Pages
