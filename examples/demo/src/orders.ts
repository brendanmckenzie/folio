/**
 * An admin screen of the host's own, shown inside Folio's chrome
 * (`platform/admin-extensions.md`, feature 2). A shop would read orders from its own
 * database; this is an in-memory list so the demo has something to frame.
 *
 * What a host page does, and all of it is on show here:
 *
 * 1. **Gate every request with `folio.requireEditor`**, a `GET`, a `POST` and any JSON
 *    endpoint the page calls. The sidebar is an affordance, not a permission. The
 *    returned `headers` carry `frame-ancestors 'self'` and `no-store`: spread them on.
 * 2. **Link `/folio-host.css`** and put `folio-host` on the body to take Folio's look
 *    (or read the `--folio-*` tokens and ignore the rest).
 * 3. **Tell the admin where it is**: the title is read from the document on every load,
 *    and `announce` adds breadcrumbs. This page speaks the protocol by hand, a
 *    `postMessage` of `{ folio: "host-page", v: 1, type: "announce", … }`, because the
 *    demo Worker serves plain HTML with no client bundle. A host with one imports
 *    `connectHostPage` from `folio/host` instead, which also keeps a site page's scope on
 *    every link, form and fetch.
 */

export interface DemoOrder {
  id: string;
  customer: string;
  state: "open" | "shipped" | "refunded";
  total: string;
  lines: { sku: string; qty: number }[];
}

export const ORDERS: readonly DemoOrder[] = [
  {
    id: "1042",
    customer: "Mina Okafor",
    state: "open",
    total: "$57.00",
    lines: [{ sku: "tee-classic-m", qty: 2 }],
  },
  {
    id: "1043",
    customer: "Jonah Reyes",
    state: "shipped",
    total: "$28.50",
    lines: [{ sku: "tee-classic-l", qty: 1 }],
  },
  {
    id: "1044",
    customer: "Ada Lindqvist",
    state: "refunded",
    total: "$94.00",
    lines: [
      { sku: "hoodie-grey-m", qty: 1 },
      { sku: "cap-navy", qty: 1 },
    ],
  },
];

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

const tone = { open: "warn", shipped: "ok", refunded: "danger" } as const;

/** The announce a page makes once loaded: crumbs after the page's own label, and a title. */
function announceScript(announce: object): string {
  return `<script>
  (function () {
    if (window.parent === window) return;
    window.parent.postMessage(Object.assign({ folio: "host-page", v: 1, type: "announce" }, ${JSON.stringify(announce)}, { path: location.pathname + location.search }), location.origin);
  })();
</script>`;
}

function page(title: string, body: string, announce: object): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/folio-host.css">
</head>
<body class="folio-host">
${body}
${announceScript(announce)}
</body>
</html>`;
}

export function ordersList(state: string | null): string {
  const rows = ORDERS.filter((o) => !state || o.state === state)
    .map(
      (o) => `<tr>
  <td><a href="/admin/orders/${o.id}">#${o.id}</a></td>
  <td>${esc(o.customer)}</td>
  <td><span class="folio-badge" data-tone="${tone[o.state]}">${o.state}</span></td>
  <td>${o.total}</td>
</tr>`,
    )
    .join("\n");
  return page(
    "Orders",
    `<h1>Orders</h1>
<p class="folio-muted"><a href="/admin/orders">All</a> · <a href="/admin/orders?state=open">Open</a> · <a href="/admin/orders?state=shipped">Shipped</a></p>
<table>
<thead><tr><th>Order</th><th>Customer</th><th>State</th><th>Total</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="4" class="folio-muted">No orders match.</td></tr>'}
</tbody>
</table>`,
    {},
  );
}

export function orderDetail(id: string): string | null {
  const order = ORDERS.find((o) => o.id === id);
  if (!order) return null;
  const lines = order.lines
    .map((l) => `<tr><td>${esc(l.sku)}</td><td>${l.qty}</td></tr>`)
    .join("\n");
  return page(
    `Order #${order.id}`,
    `<h1>Order #${order.id}</h1>
<p>${esc(order.customer)} <span class="folio-badge" data-tone="${tone[order.state]}">${order.state}</span> ${order.total}</p>
<table>
<thead><tr><th>SKU</th><th>Qty</th></tr></thead>
<tbody>
${lines}
</tbody>
</table>
<p><a class="folio-button" data-variant="subtle" href="/admin/orders?state=${order.state}">Back to ${order.state} orders</a></p>`,
    {
      title: `Order #${order.id}`,
      crumbs: [
        {
          text: `${order.state[0]?.toUpperCase()}${order.state.slice(1)} orders`,
          href: `/admin/orders?state=${order.state}`,
        },
      ],
    },
  );
}
