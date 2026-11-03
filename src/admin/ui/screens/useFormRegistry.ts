import { useEffect, useState } from "react";
import type { FormSourceInfo } from "./form-model";
import { messageOf } from "./useContent";

/**
 * The option sources the builder may offer, off `GET {base}/api/forms/registry`
 * (`form-option-sources.md` decision 17): metadata for the request's brand, signed in,
 * and never on the unauthenticated Manifest. Spec 36 reads `actions` from the same
 * route, so this is the one hook for both.
 *
 * A failure is not fatal and is not hidden: the builder still edits typed options and
 * `content`, and says the host sources could not be listed.
 */
export interface FormRegistry {
  sources: readonly FormSourceInfo[];
  loading: boolean;
  error?: string;
}

export function useFormRegistry(apiBase: string): FormRegistry {
  const [state, setState] = useState<FormRegistry>({ sources: [], loading: true });

  useEffect(() => {
    const abort = new AbortController();
    setState({ sources: [], loading: true });
    fetch(`${apiBase}/forms/registry`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await messageOf(res));
        const body = (await res.json()) as { sources?: unknown };
        const sources = Array.isArray(body.sources) ? (body.sources as FormSourceInfo[]) : [];
        setState({ sources, loading: false });
      })
      .catch((e: Error) => {
        if (abort.signal.aborted) return;
        setState({ sources: [], loading: false, error: e.message });
      });
    return () => abort.abort();
  }, [apiBase]);

  return state;
}
