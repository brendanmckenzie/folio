// Exercises content-model/media-library.md end to end against a live dev server:
// upload, a folder tree, filing, tagging, filtering by folder and by two tags, a
// bulk tag over a select-all, a bulk move, and a folder delete that leaves its
// assets unfiled.
//
// **What no workers test gives is the whole path through the mounted routes**: a
// raw-body upload into real R2, the list read back over HTTP with `?count=1`, and a
// select-all whose `expected` is the very number the list header returned. The
// behaviours are each covered against real D1 in the workers suite; this is the pass
// that drives them the way the admin does.
//
// No socket frames, so no PROTOCOL_VERSION stamping is needed here. The demo
// configures a real sign-in provider, so every route needs a session:
// `signInGlobally()` makes this process's `fetch` carry the cookie like a browser.
import "./lib/ts-resolve.mjs";
import { signInGlobally } from "./lib/auth.mjs";

await signInGlobally();

const API = "http://localhost:5199/folio/api";

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
const get = (path) => call("GET", path);
const post = (path, body) => call("POST", path, body);

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
let counter = 0;
/** A distinct png per call, so no two uploads can share bytes. */
const upload = async (filename) => {
  counter += 1;
  const res = await fetch(`${API}/assets?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array([...PNG, counter, Date.now() % 251]),
  });
  const body = await res.json();
  return { status: res.status, asset: body.asset };
};

const run = Date.now().toString(36);
const word = (s) => `${s}${run}`;

/* --- upload ------------------------------------------------------------- */

const names = Array.from({ length: 6 }, (_, i) => `ml-${run}-${i}.png`);
const assets = [];
for (const name of names) {
  const up = await upload(name);
  if (up.status === 201) assets.push(up.asset);
}
check("six uploads answer 201", assets.length === 6, `${assets.length} uploaded`);
const ids = assets.map((a) => a.id);
const [a0, a1, a2, a3, a4, a5] = ids;

const listed = await get(`/assets?q=ml-${run}&count=1`);
check(
  "the library lists every upload, with a count header",
  listed.status === 200 && listed.body.total === 6 && listed.body.rows.length === 6,
  `total ${listed.body?.total}`,
);
check(
  "a fresh upload is unfiled and untagged",
  listed.body.rows.every((r) => !r.folderId && (r.tags ?? []).length === 0),
);

/* --- folder tree -------------------------------------------------------- */

const parent = (await post("/assets/folders", { name: word("Trips") })).body;
const child = (await post("/assets/folders", { name: word("Kenya"), parentId: parent.id })).body;
const sibling = (await post("/assets/folders", { name: word("Press") })).body;
check(
  "a child folder's path extends its parent's",
  child.path.startsWith(`${parent.path}/`) && child.parentId === parent.id,
  child.path,
);
const clash = await post("/assets/folders", { name: word("Press") });
check("a name that slugifies onto a sibling is a 409", clash.status === 409, `${clash.status}`);

const tree = await get("/assets/folders?limit=500");
const order = tree.body.rows.map((f) => f.id);
check(
  "the folder list is in tree order, parent before child",
  order.indexOf(parent.id) !== -1 && order.indexOf(parent.id) < order.indexOf(child.id),
);

/* --- filing ------------------------------------------------------------- */

const filed = await call("PATCH", `/assets/${a0}`, { folderId: child.id });
check(
  "an asset can be filed into a folder",
  filed.status === 200 && filed.body.folderId === child.id,
);
await call("PATCH", `/assets/${a1}`, { folderId: parent.id });
await call("PATCH", `/assets/${a2}`, { folderId: sibling.id });

const underParent = await get(
  `/assets?q=ml-${run}&folder=${encodeURIComponent(parent.path)}&count=1`,
);
check(
  "filtering by a folder includes its descendants",
  underParent.body.total === 2 &&
    underParent.body.rows
      .map((r) => r.id)
      .sort()
      .join() === [a0, a1].sort().join(),
  `total ${underParent.body.total}`,
);
const underChild = await get(
  `/assets?q=ml-${run}&folder=${encodeURIComponent(child.path)}&count=1`,
);
check("a child folder holds only its own file", underChild.body.total === 1);
const unfiled = await get(`/assets?q=ml-${run}&unfiled=1&count=1`);
check("unfiled lists what has no folder", unfiled.body.total === 3, `total ${unfiled.body.total}`);

const badFolder = await call("PATCH", `/assets/${a3}`, { folderId: "fld_nonexistent" });
check("an unknown folder is refused", badFolder.status === 400 || badFolder.status === 404);

/* --- tagging ------------------------------------------------------------ */

const tagA = (await post("/assets/tags", { name: word("lion") })).body;
const tagB = (await post("/assets/tags", { name: word("sunset") })).body;
const again = await post("/assets/tags", { name: word("LION") });
check(
  "creating a tag whose slug exists finds it (200, same id)",
  again.status === 200 && again.body.id === tagA.id,
  `${again.status}`,
);

const t1 = await call("PATCH", `/assets/${a0}`, { tags: [tagA.id, tagB.id] });
await call("PATCH", `/assets/${a1}`, { tags: [tagA.id] });
await call("PATCH", `/assets/${a2}`, { tags: [tagB.id] });
check("a patch sets an asset's tags", t1.status === 200 && t1.body.tags.length === 2);

const both = await get(`/assets?q=ml-${run}&tags=${tagA.slug}&tags=${tagB.slug}&count=1`);
check(
  "filtering by two tags ANDs them",
  both.body.total === 1 && both.body.rows[0].id === a0,
  `total ${both.body.total}`,
);
const justA = await get(`/assets?q=ml-${run}&tags=${tagA.slug}&count=1`);
check("one tag matches every file carrying it", justA.body.total === 2);
const bothAndFolder = await get(
  `/assets?q=ml-${run}&tags=${tagA.slug}&folder=${encodeURIComponent(parent.path)}&count=1`,
);
check("a tag and a folder filter compose", bothAndFolder.body.total === 2);
const untagged = await get(`/assets?q=ml-${run}&untagged=1&count=1`);
check("untagged lists the files with no tags", untagged.body.total === 3);

const counts = await get("/assets/tags?counts=1&limit=500");
const row = counts.body.rows.find((t) => t.id === tagA.id);
check("the tag list carries per-tag counts", row?.count === 2, `count ${row?.count}`);

/* --- bulk tag over a select-all ----------------------------------------- */

const tagC = (await post("/assets/tags", { name: word("archive") })).body;
const header = await get(`/assets?q=ml-${run}&count=1`);
const selection = {
  all: true,
  filter: { q: `ml-${run}` },
  expected: header.body.total,
  exclude: [a5],
};

const dry = await post("/assets/bulk/tag", { selection, tagIds: [tagC.id], dryRun: true });
check(
  "a dry run reports the job and writes nothing",
  dry.status === 200 && dry.body.total === 5 && dry.body.dryRun === true,
  JSON.stringify(dry.body).slice(0, 120),
);
check(
  "...and nothing carries the tag yet",
  (await get(`/assets?q=ml-${run}&tags=${tagC.slug}&count=1`)).body.total === 0,
);

const stale = await post("/assets/bulk/tag", {
  selection: { ...selection, expected: header.body.total + 1 },
  tagIds: [tagC.id],
});
check(
  "a stale count is refused as a 409 carrying the real count",
  stale.status === 409 && stale.body.actual === 6 && stale.body.refused === "count",
  `${stale.status}`,
);

// Walk it in batches of two so the cursor path runs, as a screen would.
let cursor = null;
let done = 0;
let calls = 0;
do {
  const res = await post("/assets/bulk/tag", {
    selection,
    tagIds: [tagC.id],
    batch: 2,
    ...(cursor === null ? {} : { continueFrom: cursor }),
  });
  if (res.status !== 200) throw new Error(`bulk tag answered ${res.status}`);
  done += res.body.done;
  cursor = res.body.continueFrom;
  calls++;
} while (cursor !== null && calls < 20);
check(
  "a select-all tag walks to exhaustion by cursor",
  done === 5 && calls >= 3,
  `${done} in ${calls} calls`,
);

const tagged = await get(`/assets?q=ml-${run}&tags=${tagC.slug}&count=1`);
check(
  "every selected file is tagged and the excluded one is not",
  tagged.body.total === 5 && !tagged.body.rows.some((r) => r.id === a5),
  `total ${tagged.body.total}`,
);
const kept = await get(`/assets/${a0}`);
check(
  "bulk tag adds to a file's existing tags rather than replacing them",
  kept.body.tags.length === 3,
  `${kept.body.tags.length} tags`,
);

const untag = await post("/assets/bulk/untag", { selection: { ids: [a0, a1] }, tagIds: [tagC.id] });
check("untag removes a tag from named files", untag.status === 200 && untag.body.done === 2);

/* --- bulk move ---------------------------------------------------------- */

const moved = await post("/assets/bulk/move", {
  selection: { ids: [a3, a4, a5] },
  folderId: child.id,
});
check("bulk move files three assets", moved.status === 200 && moved.body.done === 3);
const inChild = await get(`/assets?q=ml-${run}&folder=${encodeURIComponent(child.path)}&count=1`);
check(
  "the folder now holds the moved files",
  inChild.body.total === 4,
  `total ${inChild.body.total}`,
);

const badMove = await post("/assets/bulk/move", {
  selection: { ids: [a3] },
  folderId: "fld_nonexistent",
});
check(
  "a move to an unknown folder is refused up front",
  badMove.status === 400,
  `${badMove.status}`,
);

const toRoot = await post("/assets/bulk/move", { selection: { ids: [a5] }, folderId: null });
check(
  "a move to null unfiles",
  toRoot.status === 200 && (await get(`/assets/${a5}`)).body.folderId === null,
);

/* --- folder delete ------------------------------------------------------ */

const del = await call("DELETE", `/assets/folders/${child.id}`);
check(
  "deleting a folder answers 200",
  del.status === 200 && del.body.deleted === true,
  JSON.stringify(del.body),
);

const survivors = await get(`/assets?q=ml-${run}&count=1`);
check("every asset survives a folder delete", survivors.body.total === 6);
const orphans = await get(`/assets?q=ml-${run}&folder=${encodeURIComponent(child.path)}&count=1`);
check("the deleted folder lists nothing", orphans.body.total === 0);
const a3After = (await get(`/assets/${a3}`)).body;
check(
  "its assets are left unfiled",
  a3After.folderId === null && (await get(`/assets/${a0}`)).body.folderId === null,
);

const treeAfter = await get("/assets/folders?limit=500");
check(
  "the folder is gone from the tree and its parent remains",
  !treeAfter.body.rows.some((f) => f.id === child.id) &&
    treeAfter.body.rows.some((f) => f.id === parent.id),
);

/* --- cleanup ------------------------------------------------------------ */

await call("DELETE", `/assets/folders/${parent.id}`);
await call("DELETE", `/assets/folders/${sibling.id}`);
for (const t of [tagA, tagB, tagC]) await call("DELETE", `/assets/tags/${t.id}`);
const gone = await post("/assets/bulk/delete", { selection: { ids } });
check(
  "bulk delete removes the uploads",
  gone.status === 200 && gone.body.done === 6,
  JSON.stringify(gone.body).slice(0, 120),
);
const left = await get(`/assets?q=ml-${run}&count=1`);
check("...and the library is empty of them", (left.body.total ?? 0) === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
