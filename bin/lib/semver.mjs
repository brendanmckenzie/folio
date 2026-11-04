/**
 * Just enough semver for `engines.node` and release ordering: `X.Y.Z` (an optional
 * leading `v`), comparison, and ranges built from `>= > <= < =`, bare versions and
 * `||`. Anything else (`^`, `~`, `x`, hyphen ranges, prerelease tags) answers
 * `"unknown"`, which `node.version` reports as a warning rather than guessing.
 */

/** `[major, minor, patch]`, or `null` when `v` is not a plain `X.Y.Z`. */
export function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive, like a sort comparator. Throws on a non-version. */
export function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * Whether `version` satisfies `range`: `true`, `false`, or `"unknown"` when the
 * range uses syntax outside the subset above.
 */
export function satisfies(version, range) {
  const v = parse(version);
  if (!v) return "unknown";
  const sets = String(range).split("||");
  let any = false;
  for (const set of sets) {
    const comparators = set
      .trim()
      .replace(/(>=|<=|>|<|=)\s+/g, "$1")
      .split(/\s+/)
      .filter(Boolean);
    if (comparators.length === 0) return "unknown";
    let all = true;
    for (const c of comparators) {
      const test = comparator(c);
      if (test === null) return "unknown";
      if (!test(v)) all = false;
    }
    if (all) any = true;
  }
  return any;
}

/** One comparator as a predicate, or `null` for syntax outside the subset. */
function comparator(text) {
  const m = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const op = m[1] ?? "";
  const parts = [m[2], m[3], m[4]].filter((p) => p !== undefined).map(Number);
  const cmp = (v) => {
    for (let i = 0; i < parts.length; i++) {
      if (v[i] !== parts[i]) return v[i] - parts[i];
    }
    return 0;
  };
  // A partial version compares on the parts it names, which is npm's reading:
  // `<27` is below 27.0.0, `>26` is at or above 27.0.0, a bare `26` is 26.x.
  switch (op) {
    case ">=":
      return (v) => cmp(v) >= 0;
    case ">":
      return (v) => cmp(v) > 0;
    case "<=":
      return (v) => cmp(v) <= 0;
    case "<":
      return (v) => cmp(v) < 0;
    default:
      return (v) => cmp(v) === 0;
  }
}
