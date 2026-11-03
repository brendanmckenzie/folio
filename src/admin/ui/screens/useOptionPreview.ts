import { useCallback, useEffect, useRef, useState } from "react";
import type { OptionsFrom } from "../../../core/option-sources";
import { type OptionPreview, previewable, previewKeyOf } from "./form-model";
import { messageOf } from "./useContent";

/**
 * `POST {base}/api/forms/:id/option-preview` for an unsaved `optionsFrom`
 * (`form-option-sources.md` decision 14). Throws the server's own message on a
 * refusal, which for a bad setting is a sentence naming it.
 */
export async function fetchOptionPreview(
  apiBase: string,
  formId: string,
  from: OptionsFrom,
  locale: string,
  signal?: AbortSignal,
): Promise<OptionPreview> {
  const res = await fetch(`${apiBase}/forms/${encodeURIComponent(formId)}/option-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ optionsFrom: from, ...(locale ? { locale } : {}) }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(await messageOf(res));
  return (await res.json()) as OptionPreview;
}

export interface OptionPreviewState {
  preview: OptionPreview | null;
  loading: boolean;
  error: string | null;
  /**
   * Ask for this descriptor's list. **Called on commit, never per keystroke**: on
   * change for a select, a boolean, the type, the parent, a filter or the sort, and on
   * blur or Enter for a text or number setting. The caller owns that distinction; this
   * only refuses to repeat itself (the same descriptor and locale as the last answer)
   * and to let a slow answer overwrite a newer one.
   */
  run: (from: OptionsFrom | undefined) => void;
}

export function useOptionPreview(
  apiBase: string,
  formId: string,
  locale: string,
  onList?: (options: OptionPreview["options"] | null) => void,
): OptionPreviewState {
  const [state, setState] = useState<Omit<OptionPreviewState, "run">>({
    preview: null,
    loading: false,
    error: null,
  });
  const latest = useRef(0);
  const lastKey = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const report = useRef(onList);
  report.current = onList;

  const run = useCallback(
    (from: OptionsFrom | undefined) => {
      if (!previewable(from)) {
        latest.current++;
        abort.current?.abort();
        lastKey.current = null;
        setState({ preview: null, loading: false, error: null });
        report.current?.(null);
        return;
      }
      const key = previewKeyOf(from, locale);
      if (key === lastKey.current) return;
      lastKey.current = key;
      const seq = ++latest.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setState((prev) => ({ ...prev, loading: true, error: null }));
      fetchOptionPreview(apiBase, formId, from, locale, controller.signal)
        .then((preview) => {
          if (seq !== latest.current) return;
          setState({ preview, loading: false, error: null });
          report.current?.(preview.options);
        })
        .catch((e: Error) => {
          if (seq !== latest.current || controller.signal.aborted) return;
          // A refused key may be retried after an edit, so it is not remembered.
          lastKey.current = null;
          setState({ preview: null, loading: false, error: e.message });
          report.current?.(null);
        });
    },
    [apiBase, formId, locale],
  );

  useEffect(() => () => abort.current?.abort(), []);

  return { ...state, run };
}
