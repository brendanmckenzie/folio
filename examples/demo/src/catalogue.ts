/**
 * The shop's catalogue, which a real host would read from its own database
 * (`platform/admin-extensions.md`, feature 3). In memory here so the demo has a list to
 * offer: `optionSources.catalogue` hands it to Folio, which keeps the last good copy in
 * `option_lists` and never calls `load` while rendering.
 *
 * `PRODUCTS` is also what the Product panel in `src/index.tsx` summarises, and what
 * `retired` shows: an id the list no longer offers but `lookup` can still name.
 */
export interface DemoProduct {
  id: string;
  name: string;
  price: string;
  variants: number;
  left: number;
}

export const PRODUCTS: readonly DemoProduct[] = [
  { id: "prod_8812", name: "Classic tee", price: "$28.50", variants: 6, left: 3 },
  { id: "prod_8813", name: "Heavyweight hoodie", price: "$74.00", variants: 4, left: 41 },
  { id: "prod_8814", name: "Canvas tote", price: "$22.00", variants: 2, left: 120 },
];

/** Retired from the list, but the catalogue still knows the name (for `lookup`). */
export const RETIRED: readonly { id: string; name: string }[] = [
  { id: "prod_7001", name: "Summer cap (retired)" },
];
