# Locus Maths

A premium Edexcel Further Maths revision web app. Learn, practise, sit exam-style 30-mark papers, and track weak spots on the radar. Built as a single self-contained `index.html` (no build step), with accounts and cross-device progress sync via Supabase.

## Deploy
Static site. The whole app is `index.html` at the repo root. Connected to Netlify: every push to the default branch auto-deploys. No build command; publish directory is the repo root (see `netlify.toml`).

## Backend
Supabase (Postgres + Auth + Row-Level Security). Only the project URL and publishable (anon) key live in the client, inside the `window.LOCUS_SB` config block near the top of `index.html`; Row-Level Security restricts every row to its owner. The secret/service_role key is never in the client.
