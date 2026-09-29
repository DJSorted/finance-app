# Finance App

Multi-company, multi-currency financials web app.
Stack: vanilla JS modules, Supabase (Postgres/Auth/Storage), Cloudflare Pages.

## Structure
- `index.html`, `pages/`: UI
- `css/theme.css`: design tokens (dark theme)
- `js/core/`: shared modules (supabase client, ui messages, auth, formatting)
- `js/modules/`: one file per page
- `sql/`: numbered database migrations, run in order in the Supabase SQL editor