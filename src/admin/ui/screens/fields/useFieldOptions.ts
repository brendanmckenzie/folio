import { useCallback, useEffect, useState } from "react";
import { type FieldOptionsAnswer, fieldOptionsUrl } from "./sourced-select-model";

/**
 * A sourced select's list from `GET {base}/api/field-options`: one request per
 * `(block, field, locale, story)`, and `reload` for the Retry beside a failed one. The
 * server refreshes a missing or stale list through the lease, so a first open may wait up
 * to ten seconds; the answer is whatever it holds then.
 */
export function useFieldOptions(
  apiBase: string,
  q: { block: string; field: string; locale?: string | null; story?: string },
): { answer: FieldOptionsAnswer | null; loading: boolean; failed: boolean; reload: () => void } {
  const [answer, setAnswer] = useState<FieldOptionsAnswer | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const url = fieldOptionsUrl(apiBase, q);

  // `nonce` is the Retry: a trigger, not a value the effect reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(url, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<FieldOptionsAnswer>) : Promise.reject(r.status)))
      .then((body) => {
        if (!live) return;
        setAnswer(body);
        setFailed(false);
      })
      .catch(() => {
        if (live) setFailed(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { answer, loading, failed, reload };
}
