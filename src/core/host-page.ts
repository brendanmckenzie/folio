/**
 * Host pages in the admin shell (`platform/admin-extensions.md`, feature 2): the
 * vocabulary shared by the server's config validation, `GET {base}/api/me` and the
 * admin's sidebar. Pure: no D1, no Hono, no React.
 */

/** The icons a host page may name. The admin draws each from its own icon set. */
export const HOST_PAGE_ICONS = [
  "window",
  "receipt",
  "box",
  "tag",
  "stack",
  "percent",
  "people",
  "chart",
] as const;
export type HostPageIcon = (typeof HOST_PAGE_ICONS)[number];

/** `HostPage.id`: the admin route segment, `{mount}/host/<id>`. */
export const HOST_PAGE_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** At most this many pages per deployment. */
export const MAX_HOST_PAGES = 20;
