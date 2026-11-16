// Exercises visitor access for media-library files (docs/specs/platform/asset-access.md)
// against a live dev server: the demo's fake `demo_member=1` cookie stands in for a real
// membership check, `gate.allowsAsset` admits it, `gate.assetDenied` redirects a stranger's
// navigation and answers an `<img>` the bare 403, and `assetSigning` mints a link that
// needs no cookie (examples/demo/src/index.tsx).
//
// What no workers test gives is the whole path through the mounted routes, with real R2
// and real headers leaving the Worker:
//
//  1. A stranger gets a bare `403` (or the host's redirect for a navigation), a member and
//     an editor session get the bytes, and **every one of those is `private, no-store`**:
//     the header is the only thing keeping a gated file out of a shared cache.
//  2. A variant (`?w=320`) is gated exactly as the original is.
//  3. A folder's value reaches the files filed in it, a file uploaded into the folder is
//     gated from its first byte, and **deleting the folder never opens a file**.
//  4. A signed URL admits a request with no cookie, and a tampered or expired one does not.
//  5. Gating a public file closes it at once, and un-gating reopens it.
//
// The edge cache does not exist locally, so what a purge reaches is
// `scripts/cache-probe.mjs --asset`'s to check, against a deployment.
import "./lib/ts-resolve.mjs";
import { signInGlobally } from "./lib/auth.mjs";

const HTTP = process.env.FOLIO_E2E_BASE ?? "http://localhost:5199";
const BASE = `${HTTP}/folio`;
const API = `${BASE}/api`;

await signInGlobally();

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
let counter = 0;
/** A distinct png per call, so no two uploads can share bytes. */
const upload = async (filename, query = "") => {
  counter += 1;
  const res = await fetch(`${API}/assets?filename=${encodeURIComponent(filename)}${query}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array([...PNG, counter, Date.now() % 251]),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, asset: body?.asset, body };
};

const run = Date.now().toString(36);
const url = (key, query = "") => `${BASE}/asset/${key}${query}`;

/** `cookie: ""` stops `signInGlobally`'s wrapper from attaching the editor session. */
const STRANGER = { cookie: "" };
const MEMBER = { cookie: "demo_member=1" };
const get = (key, headers, query = "", init = {}) => fetch(url(key, query), { headers, ...init });

const noStore = (res) => res.headers.get("cache-control") === "private, no-store";

/* --- the demo gates files ----------------------------------------------- */

const manifest = (await call("GET", "/schema")).body;
check(
  "the manifest says files are gated, with the gate field's vocabulary",
  manifest?.assetAccess?.field === "access" && manifest.assetAccess.public === "public",
  JSON.stringify(manifest?.assetAccess),
);

/* --- a file uploaded with access ---------------------------------------- */

const gated = await upload(`aa-${run}-gated.png`, "&access=members");
check(
  "an upload with ?access=members is gated from the start",
  gated.status === 201 &&
    gated.asset?.access === "members" &&
    gated.asset?.effectiveAccess === "members",
  `${gated.status} ${JSON.stringify([gated.asset?.access, gated.asset?.effectiveAccess])}`,
);
const KEY = gated.asset.key;

const stranger = await get(KEY, STRANGER, "", {
  headers: { ...STRANGER, "sec-fetch-dest": "image" },
});
const strangerBody = await stranger.arrayBuffer();
check(
  "a stranger's <img> request gets the bare 403, private and no-store",
  stranger.status === 403 && strangerBody.byteLength === 0 && noStore(stranger),
  `${stranger.status} ${stranger.headers.get("cache-control")}`,
);
check(
  "and the denial carries no cache-tag",
  stranger.headers.get("cache-tag") === null,
  stranger.headers.get("cache-tag") ?? "none",
);

const nav = await fetch(url(KEY), {
  headers: { ...STRANGER, "sec-fetch-dest": "document" },
  redirect: "manual",
});
check(
  "a stranger's navigation is redirected by gate.assetDenied, still private and no-store",
  nav.status === 302 &&
    (nav.headers.get("location") ?? "").includes("/sign-in?next=") &&
    noStore(nav),
  `${nav.status} ${nav.headers.get("location")} ${nav.headers.get("cache-control")}`,
);

const member = await get(KEY, MEMBER);
const memberBytes = await member.arrayBuffer();
check(
  "a member gets the bytes, private and no-store",
  member.status === 200 && memberBytes.byteLength > PNG.length && noStore(member),
  `${member.status} ${member.headers.get("cache-control")}`,
);
check(
  "and the sandbox headers are unchanged",
  member.headers.get("x-content-type-options") === "nosniff" &&
    (member.headers.get("content-security-policy") ?? "").includes("sandbox"),
);

const editor = await fetch(url(KEY));
check(
  "an editor's session reads the file with no cookie of the host's",
  editor.status === 200 && noStore(editor),
  `${editor.status}`,
);

const variantStranger = await get(KEY, STRANGER, "?w=320", {
  headers: { ...STRANGER, "sec-fetch-dest": "image" },
});
const variantMember = await get(KEY, MEMBER, "?w=320");
await variantMember.arrayBuffer();
check(
  "a variant is gated like the original: 403 to a stranger, private and no-store to a member",
  variantStranger.status === 403 && variantMember.status === 200 && noStore(variantMember),
  `${variantStranger.status}, ${variantMember.status} ${variantMember.headers.get("cache-control")}`,
);

const missing = await get("ast_000000000000-none.png", MEMBER);
check(
  "a key with no row is a 404 that is never cacheable",
  missing.status === 404 && noStore(missing),
  `${missing.status} ${missing.headers.get("cache-control")}`,
);

/* --- a public file keeps today's caching, and gains tags ----------------- */

const open = await upload(`aa-${run}-public.png`);
const OPEN_KEY = open.asset.key;
const openRes = await get(OPEN_KEY, STRANGER);
await openRes.arrayBuffer();
const tag = openRes.headers.get("cache-tag") ?? "";
check(
  "an ungated file is public and immutable to a stranger",
  openRes.status === 200 && (openRes.headers.get("cache-control") ?? "").includes("immutable"),
  `${openRes.status} ${openRes.headers.get("cache-control")}`,
);
check(
  "and carries asset:<id> and asset:* for the purge to find",
  tag.includes(`asset:${open.asset.id}`) && tag.includes("asset:*"),
  tag,
);

/* --- gating a public file, then un-gating it ----------------------------- */

const gating = await call("PATCH", `/assets/${open.asset.id}`, { access: "members" });
check(
  "gating a public file answers the purge owed",
  gating.status === 200 &&
    gating.body?.effectiveAccess === "members" &&
    typeof gating.body?.purge?.pending === "number",
  JSON.stringify(gating.body?.purge),
);
const nowGated = await get(OPEN_KEY, STRANGER, "", {
  headers: { ...STRANGER, "sec-fetch-dest": "image" },
});
check("the file is closed to a stranger at once", nowGated.status === 403, `${nowGated.status}`);

const purges = await call("GET", "/assets/purges");
check(
  "the purge queue reports what is owed",
  purges.status === 200 && typeof purges.body?.pending === "number",
  JSON.stringify(purges.body),
);

const reopened = await call("PATCH", `/assets/${open.asset.id}`, { access: null });
const nowOpen = await get(OPEN_KEY, STRANGER);
await nowOpen.arrayBuffer();
check(
  "inheriting again (null) reopens it",
  reopened.status === 200 && reopened.body?.effectiveAccess === null && nowOpen.status === 200,
  `${reopened.status} ${nowOpen.status}`,
);

/* --- a gated folder, an inherited file, an upload into it ---------------- */

const folder = await call("POST", "/assets/folders", {
  name: `aa-${run}-members`,
  access: "members",
});
check(
  "a folder takes an access value",
  folder.status === 201 && folder.body?.access === "members",
  JSON.stringify([folder.status, folder.body?.access, folder.body?.effectiveAccess]),
);

const filed = await upload(`aa-${run}-filed.png`, `&folderId=${folder.body.id}`);
const filedStranger = await get(filed.asset.key, STRANGER, "", {
  headers: { ...STRANGER, "sec-fetch-dest": "image" },
});
check(
  "a file uploaded into the folder inherits it and is gated from its first byte",
  filed.asset?.access === null &&
    filed.asset?.effectiveAccess === "members" &&
    filedStranger.status === 403,
  `${JSON.stringify([filed.asset?.access, filed.asset?.effectiveAccess])} ${filedStranger.status}`,
);

const moved = await upload(`aa-${run}-moved.png`);
const movedBefore = await get(moved.asset.key, STRANGER);
await movedBefore.arrayBuffer();
const move = await call("PATCH", `/assets/${moved.asset.id}`, { folderId: folder.body.id });
const movedAfter = await get(moved.asset.key, STRANGER, "", {
  headers: { ...STRANGER, "sec-fetch-dest": "image" },
});
check(
  "moving a public file into the folder gates it",
  movedBefore.status === 200 && move.status === 200 && movedAfter.status === 403,
  `${movedBefore.status} ${move.status} ${movedAfter.status}`,
);

const removed = await call("DELETE", `/assets/folders/${folder.body.id}`);
const after = await Promise.all(
  [filed.asset.key, moved.asset.key].map((key) =>
    get(key, STRANGER, "", { headers: { ...STRANGER, "sec-fetch-dest": "image" } }),
  ),
);
const rows = await Promise.all(
  [filed.asset.id, moved.asset.id].map((id) => call("GET", `/assets/${id}`)),
);
check(
  "deleting the folder never opens a file",
  removed.status === 200 &&
    after.every((r) => r.status === 403) &&
    rows.every((r) => r.body?.access === "members"),
  `${removed.status} ${after.map((r) => r.status)} ${rows.map((r) => r.body?.access)}`,
);

/* --- a signed URL, with no cookie ---------------------------------------- */

const signedFor = async (expiresIn) => {
  const src = `/folio/asset/${KEY}`;
  const res = await fetch(
    `${HTTP}/dev/sign-asset?src=${encodeURIComponent(src)}${expiresIn ? `&expiresIn=${expiresIn}` : ""}`,
    { headers: STRANGER },
  );
  return (await res.json()).url;
};

const signed = await signedFor();
const withSig = await fetch(`${HTTP}${signed}`, { headers: STRANGER });
const sigBytes = await withSig.arrayBuffer();
check(
  "a signed URL opens the file with no cookie at all, private and no-store",
  withSig.status === 200 && sigBytes.byteLength > PNG.length && noStore(withSig),
  `${withSig.status} ${withSig.headers.get("cache-control")}`,
);
check(
  "and sends no referrer",
  withSig.headers.get("referrer-policy") === "no-referrer",
  withSig.headers.get("referrer-policy") ?? "none",
);

const variantSigned = await fetch(`${HTTP}${signed}&w=320`, { headers: STRANGER });
await variantSigned.arrayBuffer();
check(
  "one signature serves every variant of the file",
  variantSigned.status === 200,
  `${variantSigned.status}`,
);

const tampered = signed.replace(/sig=(.)/, (_, c) => `sig=${c === "A" ? "B" : "A"}`);
const bad = await fetch(`${HTTP}${tampered}`, {
  headers: { ...STRANGER, "sec-fetch-dest": "image" },
});
check("a tampered signature is a denial", bad.status === 403, `${bad.status}`);

const otherKey = filed.asset.key;
const swapped = await fetch(`${HTTP}${signed.replace(KEY, otherKey)}`, {
  headers: { ...STRANGER, "sec-fetch-dest": "image" },
});
check("a signature does not open a different file", swapped.status === 403, `${swapped.status}`);

const short = await signedFor(1);
await new Promise((r) => setTimeout(r, 2200));
const expired = await fetch(`${HTTP}${short}`, {
  headers: { ...STRANGER, "sec-fetch-dest": "image" },
});
check("an expired signature is a denial", expired.status === 403, `${expired.status}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
