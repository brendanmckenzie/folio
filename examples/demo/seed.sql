-- Local-dev convenience only: a root story so `wrangler dev`'s `/folio/edit`
-- has somewhere to open straight after `pnpm db:local` (`/` itself stays 404
-- until the story is published), plus one nested page to show the tree has
-- depth. Never applied as a migration (fixed
-- ids and `insert` with no `on conflict` make it unsafe to run twice, and it
-- has no place running against a real deployment) — run once via `pnpm
-- db:seed`, after `pnpm db:local`. scripts/seed-demo.mjs seeds the actual
-- content (a full field-type showcase) through the API instead, which is safe
-- to rerun and doesn't care whether this file has been run.
insert into stories (id, parent_id, slug, path, ord, title) values
  ('sty_home',  null,        '',      '',           'a0', 'Home'),
  ('sty_about', null,        'about', 'about',      'a1', 'About'),
  ('sty_team',  'sty_about', 'team',  'about/team', 'a0', 'Our team');
