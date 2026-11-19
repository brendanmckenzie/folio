import { expect, expectTypeOf, it } from "vitest";
import type {
  ContentPage,
  ContentQuery,
  ContentQueryOptions,
  ContentSlice,
} from "../../../src/core/query";
import type { Folio, FolioReader } from "../../../src/server";

/**
 * `total: false` is additive: a caller that never mentions `total` compiles and is
 * typed exactly as before, and only a query that says `total: false` is typed a slice.
 * The assertions live in a function that is never called, so they cost nothing at run
 * time and are checked by `pnpm typecheck`, which is where a broken overload shows.
 */
declare const reader: FolioReader;
declare const folio: Folio<Cloudflare.Env>;
declare const env: Cloudflare.Env;
declare const typed: ContentQuery;
declare const wide: ContentQueryOptions;

export function overloads() {
  // Every query that does not say `total: false` still answers a page.
  expectTypeOf(reader.query({ type: "post" })).toEqualTypeOf<Promise<ContentPage>>();
  expectTypeOf(reader.query(typed)).toEqualTypeOf<Promise<ContentPage>>();
  expectTypeOf(reader.query({ type: "post", total: true })).toEqualTypeOf<Promise<ContentPage>>();
  expectTypeOf(folio.query(env, { type: "post" })).toEqualTypeOf<Promise<ContentPage>>();
  expectTypeOf(folio.query(env, typed)).toEqualTypeOf<Promise<ContentPage>>();

  // `total: false` is a slice; a plain boolean cannot say which, so it is the union.
  expectTypeOf(reader.query({ type: "post", total: false })).toEqualTypeOf<Promise<ContentSlice>>();
  expectTypeOf(folio.query(env, { type: "post", total: false })).toEqualTypeOf<
    Promise<ContentSlice>
  >();
  expectTypeOf(reader.query(wide)).toEqualTypeOf<Promise<ContentPage | ContentSlice>>();
}

it("types the query overloads (checked by tsc)", () => {
  expect(typeof overloads).toBe("function");
});
