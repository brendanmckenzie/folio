// Exercises platform/admin-extensions.md feature 2 end to end against a live dev server:
// the demo's `orders` host page, gated by `folio.requireEditor({ page })`, listed in
// `GET {base}/api/me`, answered by the shell at `{base}/host/orders`, and styled by
// `/folio-host.css`. No browser: the iframe itself, the title and crumbs it announces and
// the Back button are the owner's browser pass (`docs/specs/platform/admin-extensions.md`).
import { DEMO_ADMIN, DEMO_EDITOR, DEMO_VIEWER, signIn } from "./lib/auth.mjs";

const HTTP = process.env.FOLIO_E2E_BASE ?? "http://localhost:5199";
const BASE = `${HTTP}/folio`;

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

const admin = await signIn(HTTP, DEMO_ADMIN);
const editor = await signIn(HTTP, DEMO_EDITOR);
const viewer = await signIn(HTTP, DEMO_VIEWER);
const get = (path, cookie, init = {}) =>
  fetch(`${HTTP}${path}`, {
    redirect: "manual",
    ...init,
    headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });

/* --- the shell answers a host screen -------------------------------------- */

const shell = await get("/folio/host/orders", admin);
check(
  "{base}/host/orders answers the admin shell",
  shell.status === 200 && (shell.headers.get("content-type") ?? "").includes("text/html"),
  `status=${shell.status}`,
);
const deep = await get("/folio/host/orders/1042?tab=items", admin);
check("a deep link answers the shell too", deep.status === 200, `status=${deep.status}`);

/* --- /me lists the page, allowed from the * grant --------------------------- */

const meOf = (cookie) => get("/folio/api/me", cookie).then((r) => r.json());
const adminMe = await meOf(admin);
const viewerMe = await meOf(viewer);
check(
  "/api/me lists the orders page with its defaults for an admin",
  adminMe.hostPages?.[0]?.id === "orders" &&
    adminMe.hostPages[0].path === "/admin/orders" &&
    adminMe.hostPages[0].group === "Shop" &&
    adminMe.hostPages[0].allowed === true,
  JSON.stringify(adminMe.hostPages),
);
check(
  "a viewer's /api/me reads the page as not allowed",
  viewerMe.hostPages?.[0]?.allowed === false,
  JSON.stringify(viewerMe.hostPages),
);

/* --- the host route enforces what the page declares ------------------------- */

const page = await get("/admin/orders", admin);
const html = await page.text();
check(
  "/admin/orders answers 200 with a session",
  page.status === 200 && html.includes("<h1>Orders</h1>"),
  `status=${page.status}`,
);
check(
  "...with frame-ancestors 'self' and no-store",
  page.headers.get("content-security-policy") === "frame-ancestors 'self'" &&
    (page.headers.get("cache-control") ?? "").includes("no-store"),
  `csp=${page.headers.get("content-security-policy")} cc=${page.headers.get("cache-control")}`,
);
check(
  "...and links the host stylesheet",
  html.includes('href="/folio-host.css"') && html.includes('class="folio-host"'),
);

const anonymous = await get("/admin/orders?state=open");
check(
  "without a session it redirects to sign-in with next",
  anonymous.status === 302 &&
    anonymous.headers.get("location") === "/folio/login?next=%2Fadmin%2Forders%3Fstate%3Dopen",
  `status=${anonymous.status} location=${anonymous.headers.get("location")}`,
);

const asEditor = await get("/admin/orders", editor);
check(
  "an editor is admitted (the page's role)",
  asEditor.status === 200,
  `status=${asEditor.status}`,
);

const asViewer = await get("/admin/orders", viewer);
check(
  "a viewer is refused 403 by requireEditor, whatever the sidebar showed",
  asViewer.status === 403,
  `status=${asViewer.status}`,
);

const detail = await get("/admin/orders/1042", admin);
check(
  "an order's page answers, with the same headers",
  detail.status === 200 &&
    (await detail.text()).includes("Order #1042") &&
    detail.headers.get("content-security-policy") === "frame-ancestors 'self'",
  `status=${detail.status}`,
);
const missing = await get("/admin/orders/9999", admin);
check(
  "an unknown order is 404, still with the frame headers",
  missing.status === 404 &&
    missing.headers.get("content-security-policy") === "frame-ancestors 'self'",
  `status=${missing.status}`,
);

const cross = await get("/admin/orders", admin, {
  method: "POST",
  headers: { origin: "https://evil.example" },
});
check(
  "a POST carrying another site's Origin is 401, not admitted",
  cross.status === 401,
  `status=${cross.status}`,
);

const refused = await get("/admin/orders/refused", admin);
check(
  "the demo's refusing page sends X-Frame-Options: DENY (what the admin's notice is for)",
  refused.status === 200 &&
    refused.headers.get("x-frame-options") === "DENY" &&
    refused.headers.get("content-security-policy") === "frame-ancestors 'none'",
  `status=${refused.status}`,
);

/* --- the demo's sourced select and panel ------------------------------------- */

const json = (path, cookie) => get(path, cookie).then((r) => r.json());
const listed = await json("/folio/api/field-options?block=productRecord&field=product", admin);
check(
  "the Product record's field offers the catalogue, through the internal route",
  listed.source === "products" || listed.source === "catalogue",
  JSON.stringify(listed).slice(0, 160),
);
check(
  "...with the three products, labelled",
  listed.options?.map((o) => o.value).join() === "prod_8812,prod_8813,prod_8814" &&
    listed.options[0].label === "Classic tee",
);
const v1 = await json("/folio/api/v1/options/productRecord/product", admin);
check("the same list through the v1 route", v1.options?.length === 3 && v1.status === "fresh");
const schema = await json("/folio/api/schema", null);
check(
  "the manifest names the panel for the product type, and nothing of the sources",
  schema.panels?.product?.label === "Shop" &&
    !JSON.stringify(schema).includes("lookup") &&
    !JSON.stringify(schema).includes("optionSources"),
  JSON.stringify(schema.panels),
);

/* --- the stylesheet --------------------------------------------------------- */

const css = await get("/folio-host.css");
const cssText = await css.text();
check(
  "/folio-host.css answers CSS with the public tokens and the element layer",
  css.status === 200 &&
    (css.headers.get("content-type") ?? "").includes("css") &&
    cssText.includes("--folio-fg") &&
    cssText.includes("body.folio-host"),
  `status=${css.status} type=${css.headers.get("content-type")}`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
