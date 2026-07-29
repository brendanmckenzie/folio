-- Paths a request should be redirected away from. Written inside the same batch as
-- the rename or move that vacated them, so a path change cannot happen without its
-- redirect. Chains are collapsed on write (see the spec), so a lookup is always one
-- indexed read and a loop is unrepresentable.
create table if not exists redirects (
  -- Normalised exactly like stories.path: no leading or trailing slash, lowercased,
  -- no query string. The primary key, because one source path has one answer.
  from_path  text primary key,
  -- A path in the same form, or an absolute URL for a manual off-site redirect.
  -- Re-checked with isSafeHref on read as well as write.
  to_path    text not null,
  status     integer not null default 301 check (status in (301, 302, 307, 308)),
  -- 'auto' (a rename, move or delete) or 'manual' (an editor added it).
  source     text not null default 'auto' check (source in ('auto', 'manual')),
  -- Which story vacated the path. Informational, not a foreign key: redirects
  -- deliberately outlive the story that created them.
  story_id   text,
  created_at integer not null
);

-- For chain collapsing (update … where to_path = ?), which is the only query that
-- does not go through the primary key.
create index if not exists redirects_to on redirects (to_path);
