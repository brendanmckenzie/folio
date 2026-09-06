-- Two rows so a fresh database has somewhere to sign in and something to open.
--
-- Run once, after `npm run db:local`, with `npm run db:seed`. Fixed ids and no
-- `on conflict` make it unsafe to run twice, and it is not a migration — the
-- schema and the content are not the same thing.

-- A root story, so `/folio/edit` has somewhere to open. `/` itself stays 404
-- until you publish it. `slug` and `path` are both the empty string for the
-- root; a nested page would carry 'about' and 'about'.
insert into stories (id, type, parent_id, slug, path, ord, title) values
  ('sty_home', 'page', null, '', '', 'a0', 'Home');

-- The first editor.
--
-- A CMS with accounts has a chicken-and-egg problem: nobody can sign in until a
-- row exists, and no route may create the first admin — an endpoint that creates
-- an admin is an endpoint that creates an admin. So the first row is a deploy
-- step, and this is it.
--
-- Roles are 'viewer', 'editor', 'publisher' or 'admin'. Email is matched
-- lowercased, so one account per address rather than one per spelling.
--
-- On a real deployment, run the same insert against the remote database:
--
--   wrangler d1 execute folio --remote --command \
--     "insert into users (id, email, name, role, created_at) \
--      values ('usr_0000000000ad', 'you@example.com', 'You', 'admin', unixepoch() * 1000)"
--
insert into users (id, email, name, role, created_at) values
  ('usr_0000000000ad', 'you@example.com', 'You', 'admin', unixepoch() * 1000);
