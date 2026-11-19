import { expect, expectTypeOf, it } from "vitest";
import type { ContentPage, ContentQuery, ContentSlice } from "../../../src/core/query";
import type { Folio, FolioReader } from "../../../src/server";

/**
 * `querySlice` is additive: the type of `query` is exactly what it was, so nothing a host
 * wrote against it changes. The assertions live in a function that is never called, so
 * they cost nothing at run time and are checked by `pnpm typecheck`, where a broken
 * signature shows. The first three are the shapes a host actually writes.
 */
declare const reader: FolioReader;
declare const folio: Folio<Cloudflare.Env>;
declare const env: Cloudflare.Env;
declare const typed: ContentQuery;
declare const wrapped: ContentQuery & { total?: boolean };

export function shapes() {
  // 1. Naming the page type through the method.
  type P = Awaited<ReturnType<FolioReader["query"]>>;
  expectTypeOf<P>().toEqualTypeOf<ContentPage>();
  expectTypeOf<Awaited<ReturnType<Folio<Cloudflare.Env>["query"]>>>().toEqualTypeOf<ContentPage>();

  // 2. A hand-written double of the old shape still satisfies the interface.
  const stub: Pick<FolioReader, "query"> = {
    query: async (_q: ContentQuery): Promise<ContentPage> => ({
      items: [],
      total: 0,
      page: 1,
      perPage: 1,
      pages: 0,
    }),
  };
  const stubFolio: Pick<Folio<Cloudflare.Env>, "query"> = {
    query: async (_env: Cloudflare.Env, _q: ContentQuery): Promise<ContentPage> => ({
      items: [],
      total: 0,
      page: 1,
      perPage: 1,
      pages: 0,
    }),
  };

  // 3. A wrapper that forwards a query carrying extra fields still gets a page.
  expectTypeOf(reader.query(wrapped)).toEqualTypeOf<Promise<ContentPage>>();
  expectTypeOf(reader.query(typed)).toEqualTypeOf<Promise<ContentPage>>();
  expectTypeOf(folio.query(env, typed)).toEqualTypeOf<Promise<ContentPage>>();

  // The slice form is its own entry point.
  expectTypeOf(reader.querySlice(typed)).toEqualTypeOf<Promise<ContentSlice>>();
  expectTypeOf(folio.querySlice(env, typed)).toEqualTypeOf<Promise<ContentSlice>>();
  return [stub, stubFolio];
}

it("types the query entry points (checked by tsc)", () => {
  expect(typeof shapes).toBe("function");
});
