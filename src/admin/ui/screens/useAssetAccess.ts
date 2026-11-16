import { useCallback, useEffect, useState } from "react";
import type { Json } from "../../../core/doc";
import { accessKeysQuery, decodeAccessMap, decodePurges, type PurgeState } from "./assets-model";
import { messageOf } from "./useContent";

/**
 * The two reads visitor access to files needs beyond the library's own list
 * (`asset-access.md` phase 7). Both are inert unless asked for: a deployment that does
 * not gate files never reaches either route, which would answer `unsupported`.
 */

export interface AssetPurges {
  state: PurgeState;
  /** Ask again. Called after each access change; the notice itself never polls. */
  reload: () => void;
  /** `POST {base}/api/assets/purge-all`: true when something was purged. */
  clear: () => Promise<boolean>;
}

const NOTHING_OWED: PurgeState = { pending: 0, oldest: null };

/**
 * `GET {base}/api/assets/purges`: how many gated files may still be served from the edge
 * cache. Read once on mount and again after every access change, which is when the
 * number moves; the notice shows while it is non-zero. A failed read is "nothing owed"
 * rather than a banner about a banner.
 */
export function useAssetPurges(apiBase: string, enabled: boolean): AssetPurges {
  const [state, setState] = useState<PurgeState>(NOTHING_OWED);

  const reload = useCallback(() => {
    if (!enabled) return;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/assets/purges`);
        setState(res.ok ? decodePurges(await res.json()) : NOTHING_OWED);
      } catch {
        setState(NOTHING_OWED);
      }
    })();
  }, [apiBase, enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  const clear = useCallback(async () => {
    const res = await fetch(`${apiBase}/assets/purge-all`, { method: "POST" });
    if (!res.ok) throw new Error(await messageOf(res));
    const body = (await res.json()) as { ok?: boolean };
    reload();
    return body.ok === true;
  }, [apiBase, reload]);

  return { state, reload, clear };
}

/**
 * `GET {base}/api/assets/access?key=…`: the gated files among the open document's
 * keys, `{ [key]: value }`. One request per set of keys, refetched when the set
 * changes and not before. An empty set, or a deployment that does not gate files,
 * makes none. A failed read is "none gated": the lock is advice, and the route still
 * decides who gets the bytes.
 */
export function useAssetLocks(
  apiBase: string,
  keys: readonly string[],
  enabled: boolean,
): Readonly<Record<string, Json>> {
  const [gated, setGated] = useState<Readonly<Record<string, Json>>>({});
  // A value, not the array: the caller builds a fresh array each render.
  const wanted = enabled ? accessKeysQuery(keys).toString() : "";

  useEffect(() => {
    if (wanted === "") {
      setGated((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/assets/access?${wanted}`);
        const next = res.ok ? decodeAccessMap(await res.json()) : {};
        if (live) setGated(next);
      } catch {
        if (live) setGated({});
      }
    })();
    return () => {
      live = false;
    };
  }, [apiBase, wanted]);

  return gated;
}
