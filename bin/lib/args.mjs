/**
 * Per-command flag parsing over `node:util`'s `parseArgs`, strictly.
 *
 * Each command declares its own options, so `--email` is refused on `doctor` and
 * `--remote` on `init` (spec 41 decision 11). An unknown option, a missing value or
 * a stray positional is a usage error, which every command answers with exit 2.
 */
import { parseArgs } from "node:util";

/** A mistake in how the command was invoked. `bin/folio.mjs` exits 2 on one. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

/**
 * @param {string[]} argv the arguments after the command name
 * @param {Record<string, { type: "string" | "boolean", multiple?: boolean, short?: string }>} options
 * @param {{ positionals?: number }} [limits] how many positionals the command takes (default 1)
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
export function parse(argv, options, { positionals = 1 } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (err) {
    throw new UsageError(err.message.replace(/\. To specify a positional argument.*$/s, "."));
  }
  if (parsed.positionals.length > positionals) {
    throw new UsageError(`unexpected argument "${parsed.positionals[positionals]}"`);
  }
  for (const [name, spec] of Object.entries(options)) {
    const value = parsed.values[name];
    if (spec.type !== "string" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === "" || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    }
  }
  return { values: parsed.values, positionals: parsed.positionals };
}
