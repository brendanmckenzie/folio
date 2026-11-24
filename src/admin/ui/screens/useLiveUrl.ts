import { useEffect, useState } from "react";
import { isLive, type StoryMeta } from "../../../core/story";

/**
 * A record's public URL for "View live" (`record-live-url.md`), or null.
 *
 * Asked of the server, because the host's `liveUrls` function and never leaves it,
 * and computed there from the **published** document. `enabled` is the caller's cheap
 * test (the type declares one, and the deployment is not multi-site); a record that is
 * not live is not asked at all. It asks again when a publish or an unpublish moves the
 * row, which is exactly when the published data, and so the answer, can change; a
 * failed read is no link, never an error in the editor.
 */
export function useLiveUrl(
  apiBase: string,
  story: Pick<StoryMeta, "id" | "state" | "publishedAt" | "unpublishedAt" | "publishedSyncId">,
  enabled: boolean,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const { id, state, publishedAt, unpublishedAt, publishedSyncId } = story;
  const asks = enabled && isLive(state);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the publish stamps re-ask on purpose
  useEffect(() => {
    if (!asks) {
      setUrl(null);
      return;
    }
    let live = true;
    fetch(`${apiBase}/story/${encodeURIComponent(id)}/live-url`)
      .then((res) => (res.ok ? (res.json() as Promise<{ url: string | null }>) : { url: null }))
      .then(({ url: answer }) => {
        if (live) setUrl(typeof answer === "string" ? answer : null);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
    };
  }, [apiBase, asks, id, publishedAt, unpublishedAt, publishedSyncId]);

  return asks ? url : null;
}
