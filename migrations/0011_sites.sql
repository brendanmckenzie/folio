-- The site dimension, and roles as grants on a scope
-- (docs/specs/foundation/multi-site.md, "D1 migration `0011_sites.sql`").
--
-- The expand half of decision 18: `users.role` and `users.role_from` stay, unread
-- by the code that ships with this file, until `0012_users_role_contract.sql`
-- drops them in the release after. Apply this, then deploy within minutes, and
-- change no roles in between (UPGRADING.md). No triggers, deliberately.
--
-- Every table this alters or rebuilds exists by `0010`. Plain statements: applied
-- twice it fails loudly. The three rebuilds (`redirects`, `asset_folders`,
-- `asset_tags`) are the tables whose unique key is a primary key or a column
-- constraint, neither of which SQLite can re-key in place; nothing holds a foreign
-- key into any of them, so dropping the old table cascades nowhere.

-- The registry: sites and groups, and the hostnames that reach each site.
create table sites (
  id             text primary key,
  kind           text not null check (kind in ('site', 'group')),
  name           text not null,
  group_id       text,
  status         text check (status in ('draft', 'preview', 'live')),
  preview_origin text,
  created_at     integer not null,
  updated_at     integer not null
);
create unique index sites_preview on sites (preview_origin) where preview_origin is not null;
create index sites_group on sites (group_id);
create table site_hosts (
  host    text primary key,
  site_id text not null
);
create index site_hosts_site on site_hosts (site_id);
insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at)
  values ('default', 'site', 'Default', null, 'live', null,
          unixepoch() * 1000, unixepoch() * 1000);

-- stories: owner scope, fork provenance, every index with the site leading.
alter table stories add column site_id text not null default 'default';
alter table stories add column forked_from text;
drop index stories_path;
create unique index stories_path on stories (site_id, path) where path is not null;
drop index stories_parent_slug;
create unique index stories_parent_slug
  on stories (site_id, coalesce(parent_id, ''), slug) where path is not null;
drop index stories_type_slug;
create unique index stories_type_slug on stories (site_id, type, slug) where path is null;
drop index stories_parent_ord;
create index stories_parent_ord on stories (site_id, parent_id, ord);
drop index stories_type;
create index stories_type on stories (site_id, type, ord);
drop index stories_edited;
create index stories_edited
  on stories (site_id, coalesce(draft_updated_at, updated_at) desc, id desc);
drop index stories_title;
create index stories_title on stories (site_id, title, id);

-- redirects: rebuilt, because the primary key changes.
create table redirects_next (
  from_path  text not null,
  to_path    text not null,
  status     integer not null default 301 check (status in (301, 302, 307, 308)),
  source     text not null default 'auto' check (source in ('auto', 'manual')),
  story_id   text,
  created_at integer not null,
  site_id    text not null default 'default',
  primary key (site_id, from_path)
);
insert into redirects_next (from_path, to_path, status, source, story_id, created_at, site_id)
  select from_path, to_path, status, source, story_id, created_at, 'default' from redirects;
drop table redirects;
alter table redirects_next rename to redirects;
create index redirects_to on redirects (site_id, to_path);

-- assets and their organisation.
alter table assets add column site_id text not null default 'default';
drop index assets_created;
create index assets_created on assets (site_id, created_at desc);
drop index assets_filename;
create index assets_filename on assets (site_id, filename, id);
drop index assets_size;
create index assets_size on assets (site_id, size desc, id);

create table asset_folders_next (
  id         text primary key,
  parent_id  text,
  name       text not null,
  path       text not null,
  created_at integer not null,
  site_id    text not null default 'default'
);
insert into asset_folders_next (id, parent_id, name, path, created_at, site_id)
  select id, parent_id, name, path, created_at, 'default' from asset_folders;
drop table asset_folders;
alter table asset_folders_next rename to asset_folders;
create unique index asset_folders_path on asset_folders (site_id, path);
create index asset_folders_parent on asset_folders (parent_id, name);

create table asset_tags_next (
  id         text primary key,
  name       text not null,
  slug       text not null,
  created_at integer not null,
  site_id    text not null default 'default'
);
insert into asset_tags_next (id, name, slug, created_at, site_id)
  select id, name, slug, created_at, 'default' from asset_tags;
drop table asset_tags;
alter table asset_tags_next rename to asset_tags;
create unique index asset_tags_slug on asset_tags (site_id, slug);

-- forms: owned by a scope; a response records the site it was submitted on.
alter table forms add column site_id text not null default 'default';
drop index forms_name;
create unique index forms_name on forms (site_id, name);
drop index forms_updated;
create index forms_updated on forms (site_id, updated_at desc, id);
alter table form_responses add column site_id text not null default 'default';
create index form_responses_site on form_responses (form_id, site_id, created_at desc, id);

-- shares render in one site's context; tokens may be bound to one scope.
alter table shares add column site_id text not null default 'default';
alter table api_tokens add column site_id text;

-- grants: a role on a scope. `*` is every scope. Backfilled once; no triggers.
create table site_roles (
  user_id    text not null references users(id) on delete cascade,
  scope_id   text not null,
  role       text not null check (role in ('viewer', 'editor', 'publisher', 'admin')),
  role_from  text,
  created_at integer not null,
  primary key (user_id, scope_id)
);
create index site_roles_scope on site_roles (scope_id, user_id);
insert into site_roles (user_id, scope_id, role, role_from, created_at)
  select id, '*', role, role_from, created_at from users;

-- the preview handoff: a code, then a grant, on one row; a session's or a token's.
create table site_grants (
  id         text primary key,
  session_id text,
  token_id   text,
  site_id    text not null,
  code_hash  text,
  token_hash text,
  created_at integer not null,
  expires_at integer not null,
  check ((session_id is null) <> (token_id is null))
);
create unique index site_grants_code on site_grants (code_hash) where code_hash is not null;
create unique index site_grants_token on site_grants (token_hash) where token_hash is not null;
create index site_grants_session on site_grants (session_id);
create index site_grants_expiry on site_grants (expires_at);
