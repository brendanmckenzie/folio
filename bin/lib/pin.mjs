/**
 * What kind of thing a host's `folio` dependency names.
 *
 * The npm registry's `folio` is somebody else's package (the Playwright team's
 * pre-Playwright runner), so every registry range installs a stranger's code, and
 * the only good answer is a git spec ending in an exact `#vX.Y.Z` tag.
 *
 * @typedef {"tag" | "sha" | "short-sha" | "branch" | "semver-range" | "default-branch" | "local-git" | "path" | "workspace" | "registry"} PinKind
 */

/** @returns {{ kind: PinKind, ref: string | null, version?: string }} */
export function classifyPin(spec) {
  const s = String(spec).trim();
  if (s.startsWith("workspace:")) return { kind: "workspace", ref: s.slice(10) };
  if (s.startsWith("file:") || s.startsWith("link:")) return { kind: "path", ref: s };
  if (s.startsWith("git+file:")) return { kind: "local-git", ref: refOf(s) };
  if (!isGit(s)) return { kind: "registry", ref: s };

  const ref = refOf(s);
  if (ref === null || ref === "") return { kind: "default-branch", ref: null };
  if (ref.startsWith("semver:")) return { kind: "semver-range", ref };
  const tag = /^v(\d+\.\d+\.\d+)$/.exec(ref);
  if (tag) return { kind: "tag", ref, version: tag[1] };
  if (/^[0-9a-f]{40}$/i.test(ref)) return { kind: "sha", ref };
  if (/^[0-9a-f]{7,39}$/i.test(ref)) return { kind: "short-sha", ref };
  return { kind: "branch", ref };
}

/** Whether a spec is a git dependency of any spelling npm accepts. */
function isGit(s) {
  return (
    /^(github|gitlab|bitbucket):/.test(s) ||
    /^git(\+(ssh|https?))?:\/\//.test(s) ||
    /^https?:\/\/.+\.git(#|$)/.test(s) ||
    // npm's bare `owner/repo` shorthand for GitHub.
    /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)
  );
}

function refOf(s) {
  const i = s.indexOf("#");
  return i === -1 ? null : s.slice(i + 1);
}
