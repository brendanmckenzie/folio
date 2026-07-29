-- Local-dev convenience only: a root story so `wrangler dev`'s `/folio/edit`
-- has somewhere to open straight after `pnpm db:local` (`/` itself stays 404
-- until the story is published), plus one nested page to show the tree has
-- depth. Never applied as a migration (fixed
-- ids and `insert` with no `on conflict` make it unsafe to run twice, and it
-- has no place running against a real deployment) — run once via `pnpm
-- db:seed`, after `pnpm db:local`. scripts/seed-demo.mjs seeds the actual
-- content (a full field-type showcase) through the API instead, which is safe
-- to rerun and doesn't care whether this file has been run.
-- `type` is named explicitly rather than left to 0006's `default 'page'`: this
-- file is also the workers-test fixture (test/workers/seed-fixture.ts), so it is
-- where a mistake about which document type a seeded row belongs to would show
-- up first.
insert into stories (id, type, parent_id, slug, path, ord, title) values
  ('sty_home',  'page', null,        '',      '',           'a0', 'Home'),
  ('sty_about', 'page', null,        'about', 'about',      'a1', 'About'),
  ('sty_team',  'page', 'sty_about', 'team',  'about/team', 'a0', 'Our team');

-- Editors, for identity-and-access.md. Local-dev convenience exactly like the
-- stories above: the demo configures a real sign-in provider, and a CMS with
-- accounts has a chicken-and-egg problem — nobody can sign in until a row
-- exists, and no route may create the first admin (an endpoint that creates an
-- admin is an endpoint that creates an admin). Seeding the first row is a deploy
-- step; `wrangler d1 execute` is the answer on a real deployment.
--
-- Three roles, so scripts/auth-test.mjs can exercise the role table rather than
-- describe it: `demo@example.com` is the admin the other e2e scripts sign in as.
insert into users (id, email, name, role, created_at) values
  ('usr_demoadmin1', 'demo@example.com',   'Demo Admin',  'admin',  unixepoch() * 1000),
  ('usr_demoeditor', 'editor@example.com', 'Demo Editor', 'editor', unixepoch() * 1000),
  ('usr_demoviewer', 'viewer@example.com', 'Demo Viewer', 'viewer', unixepoch() * 1000);
