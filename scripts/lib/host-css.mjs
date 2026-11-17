/**
 * `folio-host.css` from `src/admin/ui/tokens.css` and `src/admin/host/host.css`
 * (`platform/admin-extensions.md` decision 11).
 *
 * The **semantic tier only** is published, renamed with a `--folio-` prefix so it cannot
 * collide with a host's own custom properties in the host's own document. The scale tier
 * (`--n-300`, `--blue-500`) is not published ("the scale has no dark-mode answer"), so a
 * semantic value that points at it is resolved to the literal here. The light, the
 * `prefers-color-scheme: dark` and the `[data-theme="dark"]` blocks are carried over with
 * the same selectors.
 */

/** The public set, unprefixed: what a host page may read. */
export const PUBLIC_TOKENS = [
  "bg-app",
  "bg-panel",
  "bg-inset",
  "bg-hover",
  "fg",
  "fg-muted",
  "fg-subtle",
  "fg-accent",
  "border",
  "border-strong",
  "ring",
  ...["ok", "warn", "danger", "accent"].flatMap((s) =>
    ["bg", "border", "fg"].map((p) => `state-${s}-${p}`),
  ),
  ...["xs", "sm", "base", "lg", "xl"].map((n) => `text-${n}`),
  ...[0, 1, 2, 3, 4, 5, 6].map((n) => `space-${n}`),
  ...["sm", "md", "lg", "full"].map((n) => `radius-${n}`),
  "font-ui",
  "font-mono",
];

const SCALE = /^(?:n|blue|green|amber|red)-\d+$/;
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(body) {
  const out = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1].slice(2), m[2].trim());
  return out;
}

function block(css, pattern, what) {
  const m = css.match(pattern);
  if (!m) throw new Error(`host-css: tokens.css has no ${what} block`);
  return m[1];
}

export function buildHostCss(tokensCss, elementCss) {
  const css = stripComments(tokensCss);
  const root = declarations(block(css, /:root\s*\{([^{}]*)\}/, ":root"));
  const dark = declarations(
    block(
      css,
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^{}]*)\}/,
      "prefers-color-scheme dark",
    ),
  );
  const themed = declarations(
    block(css, /\[data-theme="dark"\]\s*\{([^{}]*)\}/, '[data-theme="dark"]'),
  );

  const scale = new Map([...root].filter(([name]) => SCALE.test(name)));
  const publish = (value) =>
    value.replace(/var\(--([\w-]+)\)/g, (whole, name) => {
      if (scale.has(name)) return scale.get(name);
      if (PUBLIC_TOKENS.includes(name)) return `var(--folio-${name})`;
      throw new Error(`host-css: a public token points at unpublished '--${name}'`);
    });
  const emit = (map, scheme) => {
    const lines = PUBLIC_TOKENS.filter((name) => map.has(name)).map(
      (name) => `  --folio-${name}: ${publish(map.get(name))};`,
    );
    if (scheme) lines.push(`  color-scheme: ${scheme};`);
    return lines.join("\n");
  };
  for (const name of PUBLIC_TOKENS) {
    if (!root.has(name)) throw new Error(`host-css: tokens.css does not declare '--${name}'`);
  }

  return [
    "/* folio-host.css: Folio's semantic tokens as --folio-*, and an opt-in element layer under body.folio-host. */",
    `:root {\n${emit(root, "light")}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${emit(dark, "dark").replace(/^/gm, "  ")}\n  }\n}`,
    `[data-theme="dark"] {\n${emit(themed, "dark")}\n}`,
    elementCss.trim(),
    "",
  ].join("\n");
}
