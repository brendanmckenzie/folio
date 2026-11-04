/**
 * `folio add block <name>`: one new file, two lines in the blocks module, and
 * optionally one entry in a root's `allow`.
 *
 * A block is schema and renderer in one `defineBlock`, and the preview bundle is
 * generated from the same `blocks` module the Worker renders with, so listing it
 * there is its preview registration. `--into <block>.<field>` is the third edit,
 * the one that makes it insertable.
 *
 * Text edits under strict patterns (spec 41 decision 10). Every edit is computed
 * before anything is written; if a pattern does not match exactly once, nothing is
 * written and the caller gets the edit to make by hand. Quote style, semicolons
 * and indentation come from the file being edited.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UsageError } from "./args.mjs";
import { indentAt, spansLines, stringValue, tokenize } from "./scan.mjs";

export const ADD_BLOCK_SCHEMA = "folio.add-block/1";

const NAME = /^[a-z][A-Za-z0-9]*$/;
const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends " +
    "false finally for function if import in instanceof new null return super switch this throw " +
    "true try typeof var void while with yield let static implements interface package private " +
    "protected public await arguments eval undefined"
  ).split(" "),
);

/** An add this command will not guess at: exit 1, nothing written, `fix` says what to do by hand. */
export class AddBlockRefusal extends Error {
  constructor(message, fix) {
    super(message);
    this.name = "AddBlockRefusal";
    this.fix = fix;
  }
}

/** Refuses a name that is not a valid, unreserved camelCase identifier (exit 2). */
export function validateName(name) {
  if (!NAME.test(name)) {
    throw new UsageError(
      `"${name}" is not a block name: it must match ^[a-z][A-Za-z0-9]*$ (camelCase, starting with a lowercase letter)`,
    );
  }
  if (RESERVED.has(name)) {
    throw new UsageError(
      `"${name}" is a reserved word in JavaScript, so it cannot name the block's export`,
    );
  }
}

/** `travelCard` → "Travel card". */
export function labelOf(name) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words[0].toUpperCase() + words.slice(1);
}

/** `travelCard` → `travel-card`. */
export function kebabOf(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Every edit `add block` would make, computed and not written.
 *
 * @param {{ module: string, name: string, label?: string, into?: string | null,
 *   read?: (file: string) => string }} input `module` is the blocks module's absolute path
 * @returns {{ files: { path: string, action: "create" | "edit", before: string | null, after: string }[] }}
 */
export function planAddBlock({ module, name, label, into, read = (f) => readFileSync(f, "utf8") }) {
  validateName(name);
  const dir = path.dirname(module);
  for (const ext of [".tsx", ".ts", ".jsx", ".js"]) {
    const existing = path.join(dir, `${name}${ext}`);
    if (existsSync(existing)) throw new UsageError(`${existing} already exists`);
  }
  const intoParts = into ? parseInto(into) : null;

  const source = read(module);
  const tokens = tokenize(source);
  const imports = topLevelImports(tokens);
  for (const imp of imports) {
    if (imp.bindings.includes(name)) {
      throw new UsageError(
        `"${name}" is already imported in ${module} (from ${imp.specifier}); pick another name`,
      );
    }
  }
  const declared = blockFiles(dir).find((f) => declaresBlock(read(f), name));
  if (declared) throw new UsageError(`${declared} already declares a block named "${name}"`);

  const style = styleOf(source, tokens, imports);
  const q = style.quote;
  const semi = style.semi ? ";" : "";
  const importLine = `import { ${name} } from ${q}./${name}${q}${semi}`;
  const manual = (why) =>
    new AddBlockRefusal(`${why}. Nothing was written.`, [
      {
        kind: "edit",
        file: module,
        text: "after the last import",
        snippet: importLine,
      },
      {
        kind: "edit",
        file: module,
        text: "as the last element of the exported blocks array",
        snippet: `${name},`,
      },
      ...(intoParts
        ? [
            {
              kind: "edit",
              file: `the file declaring name: "${intoParts.block}"`,
              text: `in ${intoParts.field}'s blocks({ allow: [...] })`,
              snippet: `${q}${name}${q}`,
            },
          ]
        : []),
    ]);

  // 1. The import, after the last top-level import.
  const edits = [];
  const lastImport = imports.at(-1);
  if (lastImport) edits.push({ at: lastImport.end, text: `\n${importLine}` });
  else edits.push({ at: 0, text: `${importLine}\n` });

  // 2. The array entry.
  const array = blocksArray(tokens);
  if (array.error) throw manual(array.error);
  const entry = arrayInsertion(source, tokens, array.open, name);
  if (entry.error) throw manual(entry.error);
  edits.push(entry);

  const after = applyTextEdits(source, edits);
  const files = [
    {
      path: path.join(dir, `${name}.tsx`),
      action: "create",
      before: null,
      after: template(name, label ?? labelOf(name), style),
    },
    { path: module, action: "edit", before: source, after },
  ];

  // 3. --into: the root's allow list.
  if (intoParts) {
    const target = allowEdit({
      dir,
      read,
      block: intoParts.block,
      field: intoParts.field,
      name,
      quote: q,
    });
    if (target.error) throw manual(target.error);
    if (target.file === module) {
      throw manual(
        "the --into block is declared in the blocks module itself, which this command does not edit twice",
      );
    }
    if (target.after !== target.before) {
      files.push({ path: target.file, action: "edit", before: target.before, after: target.after });
    }
  }
  return { files };
}

function parseInto(into) {
  const m = /^([a-z][A-Za-z0-9]*)\.([A-Za-z_$][\w$]*)$/.exec(into);
  if (!m) throw new UsageError(`--into takes <block>.<field>, such as page.body, not "${into}"`);
  return { block: m[1], field: m[2] };
}

/**
 * Writes every file or none: originals are held in memory and put back, and created
 * files removed, if any write fails.
 */
export function applyEdits(files, { write = writeFileSync, remove = rmSync } = {}) {
  const done = [];
  try {
    for (const f of files) {
      write(f.path, f.after);
      done.push(f);
    }
  } catch (err) {
    for (const f of done.reverse()) {
      try {
        if (f.before === null) remove(f.path, { force: true });
        else writeFileSync(f.path, f.before);
      } catch {}
    }
    throw err;
  }
}

/* ---------------------------------------------------------------- scanning --- */

/** Top-level `import … from "x"` and `import "x"` statements, with their bindings. */
export function topLevelImports(tokens) {
  const found = [];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t !== "id" || tok.v !== "import" || tok.depth !== 0) continue;
    const next = tokens[k + 1];
    if (!next || (next.t === "p" && (next.v === "(" || next.v === "."))) continue;
    const prev = tokens[k - 1];
    if (prev && !(prev.t === "p" && (prev.v === ";" || prev.v === "}")) && prev.t !== "str")
      continue;
    let j = k + 1;
    const bindings = [];
    while (j < tokens.length && !(tokens[j].t === "str" && tokens[j].depth === 0)) {
      if (tokens[j].t === "id" && !["type", "from", "as"].includes(tokens[j].v))
        bindings.push(tokens[j].v);
      j++;
    }
    if (j >= tokens.length) break;
    const spec = tokens[j];
    const semi = tokens[j + 1]?.t === "p" && tokens[j + 1].v === ";" ? tokens[j + 1] : null;
    found.push({
      start: tok.s,
      end: (semi ?? spec).e,
      specifier: stringValue(spec).value,
      quote: spec.v[0],
      semi: Boolean(semi),
      bindings: bindings.filter((b) => b !== "import"),
    });
    k = j;
  }
  return found;
}

/** The `[` of `export const blocks = [ … ]`, or why it cannot be edited. */
function blocksArray(tokens) {
  const starts = [];
  for (let k = 0; k + 2 < tokens.length; k++) {
    const [a, b, c] = [tokens[k], tokens[k + 1], tokens[k + 2]];
    if (a.depth === 0 && a.v === "export" && b.v === "const" && c.v === "blocks")
      starts.push(k + 2);
  }
  if (starts.length !== 1) {
    return {
      error: starts.length
        ? "the module exports blocks more than once"
        : "the module has no `export const blocks`",
    };
  }
  let k = starts[0] + 1;
  while (k < tokens.length && !(tokens[k].v === "=" && tokens[k].depth === 0)) k++;
  const open = tokens[k + 1];
  if (!open || open.v !== "[" || open.close === undefined) {
    return { error: "`blocks` is not an array literal" };
  }
  for (let j = k + 2; j < open.close; j++) {
    if (tokens[j].v === "..." && tokens[j].depth === open.depth + 1) {
      return { error: "`blocks` is built with a spread" };
    }
  }
  return { open: k + 1 };
}

/**
 * The edit appending `entry` as the last element of the array whose `[` is
 * `tokens[openIndex]`, matching the array's own layout: a new line at the last
 * element's indentation when it spans lines, `, entry` when it is inline.
 */
function arrayInsertion(
  source,
  tokens,
  openIndex,
  entry,
  duplicate = (t) => t.t === "id" && t.v === entry,
) {
  const open = tokens[openIndex];
  const closeIndex = open.close;
  for (let j = openIndex + 1; j < closeIndex; j++) {
    if (tokens[j].depth === open.depth + 1 && duplicate(tokens[j])) {
      return { error: `${entry} is already listed` };
    }
  }
  const last = tokens[closeIndex - 1];
  const close = tokens[closeIndex];
  if (closeIndex === openIndex + 1) return { at: open.e, text: entry };
  const trailing = last.t === "p" && last.v === ",";
  if (spansLines(source, open.e, close.s)) {
    const indent = indentAt(source, last.s);
    return trailing
      ? { at: last.e, text: `\n${indent}${entry},` }
      : { at: last.e, text: `,\n${indent}${entry}` };
  }
  return trailing ? { at: last.e, text: ` ${entry},` } : { at: last.e, text: `, ${entry}` };
}

/** The quote character and semicolon habit of a file, read from its imports. */
function styleOf(source, tokens, imports) {
  const last = imports.at(-1);
  const quote = last?.quote ?? tokens.find((t) => t.t === "str")?.v[0] ?? '"';
  const semi = last ? last.semi : /;\s*$/m.test(source);
  const array = blocksArray(tokens);
  const first = array.open !== undefined ? tokens[array.open + 1] : undefined;
  const indent =
    first && array.open !== undefined && spansLines(source, tokens[array.open].e, first.s)
      ? indentAt(source, first.s)
      : "  ";
  return { quote, semi, indent: indent || "  " };
}

function blockFiles(dir, depth = 0) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = path.join(dir, e);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory() && depth < 3) out.push(...blockFiles(p, depth + 1));
    else if (/\.(tsx?|jsx?|mts)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
  }
  return out.sort();
}

/** Whether a source declares `name: "<block>"` (either quote) anywhere. */
function declaresBlock(source, block) {
  return nameTokens(tokenize(source), block).length > 0;
}

function nameTokens(tokens, block) {
  const at = [];
  for (let k = 0; k + 2 < tokens.length; k++) {
    const [a, b, c] = [tokens[k], tokens[k + 1], tokens[k + 2]];
    if (
      a.t === "id" &&
      a.v === "name" &&
      b.v === ":" &&
      c.t === "str" &&
      stringValue(c).value === block
    ) {
      at.push(k);
    }
  }
  return at;
}

/** The edit adding `name` to `<block>.<field>`'s `blocks({ allow: [...] })`. */
function allowEdit({ dir, read, block, field, name, quote }) {
  const hits = [];
  for (const file of blockFiles(dir)) {
    const source = read(file);
    const tokens = tokenize(source);
    for (const k of nameTokens(tokens, block)) hits.push({ file, source, tokens, k });
  }
  if (hits.length !== 1) {
    return {
      error: hits.length
        ? `${hits.length} files declare name: "${block}"`
        : `no file under ${dir} declares a block named "${block}"`,
    };
  }
  const { file, source, tokens, k } = hits[0];
  const objDepth = tokens[k].depth;
  // The object literal holding `name`: its `fields: { … }`.
  let fieldsOpen = -1;
  for (let j = k + 1; j < tokens.length && tokens[j].depth >= objDepth; j++) {
    const t = tokens[j];
    if (
      t.depth === objDepth &&
      t.v === "fields" &&
      tokens[j + 1]?.v === ":" &&
      tokens[j + 2]?.v === "{"
    ) {
      fieldsOpen = j + 2;
      break;
    }
  }
  for (let j = k - 1; fieldsOpen === -1 && j >= 0 && tokens[j].depth >= objDepth; j--) {
    const t = tokens[j];
    if (
      t.depth === objDepth &&
      t.v === "fields" &&
      tokens[j + 1]?.v === ":" &&
      tokens[j + 2]?.v === "{"
    ) {
      fieldsOpen = j + 2;
    }
  }
  if (fieldsOpen === -1 || tokens[fieldsOpen].close === undefined) {
    return { error: `could not find ${block}'s fields in ${file}` };
  }
  const fieldsClose = tokens[fieldsOpen].close;
  const inner = tokens[fieldsOpen].depth + 1;
  const keys = [];
  for (let j = fieldsOpen + 1; j < fieldsClose; j++) {
    const t = tokens[j];
    const key = t.t === "id" ? t.v : t.t === "str" ? stringValue(t).value : null;
    if (t.depth === inner && key === field && tokens[j + 1]?.v === ":") keys.push(j);
  }
  if (keys.length !== 1) return { error: `${block} has no field named ${field} in ${file}` };
  const call = keys[0] + 2;
  if (tokens[call]?.v !== "blocks" || tokens[call + 1]?.v !== "(") {
    return { error: `${block}.${field} is not a blocks() field` };
  }
  const paren = tokens[call + 1];
  let allowOpen = -1;
  for (let j = call + 2; j < paren.close; j++) {
    if (tokens[j].v === "allow" && tokens[j + 1]?.v === ":" && tokens[j + 2]?.v === "[") {
      allowOpen = j + 2;
      break;
    }
  }
  if (allowOpen === -1 || tokens[allowOpen].close === undefined) {
    return { error: `${block}.${field}'s blocks() has no allow: [...] literal` };
  }
  for (let j = allowOpen + 1; j < tokens[allowOpen].close; j++) {
    const t = tokens[j];
    if (!(t.t === "str" || (t.t === "p" && t.v === ","))) {
      return { error: `${block}.${field}'s allow is not a plain list of names` };
    }
  }
  const existingQuote = tokens[allowOpen + 1]?.t === "str" ? tokens[allowOpen + 1].v[0] : quote;
  const entry = `${existingQuote}${name}${existingQuote}`;
  const edit = arrayInsertion(
    source,
    tokens,
    allowOpen,
    entry,
    (t) => t.t === "str" && stringValue(t).value === name,
  );
  if (edit.error) return { file, before: source, after: source };
  return { file, before: source, after: applyTextEdits(source, [edit]) };
}

function applyTextEdits(source, edits) {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, e.at) + e.text + out.slice(e.at);
  }
  return out;
}

/** The new block file, modelled on the starter's `prose.tsx`, in the module's style. */
function template(name, label, { quote: q, semi, indent: i }) {
  const s = semi ? ";" : "";
  const kebab = kebabOf(name);
  const str = (v) => `${q}${v.replaceAll("\\", "\\\\").replaceAll(q, `\\${q}`)}${q}`;
  return [
    `import { defineBlock, text } from ${q}folio/core${q}${s}`,
    "",
    `export const ${name} = defineBlock({`,
    `${i}name: ${str(name)},`,
    `${i}label: ${str(label)},`,
    `${i}summary: ${str("heading")},`,
    `${i}fields: {`,
    `${i}${i}heading: text({ label: ${str("Heading")}, required: true }),`,
    `${i}},`,
    `${i}render: ({ heading }) => (`,
    `${i}${i}<section className="${kebab}">`,
    `${i}${i}${i}<h2 className="${kebab}__heading">{heading}</h2>`,
    `${i}${i}</section>`,
    `${i}),`,
    `})${s}`,
    "",
  ].join("\n");
}

/* -------------------------------------------------------------------- diff --- */

/** A unified diff of two texts, one line of context, for the JSON answer. */
export function unifiedDiff(before, after, context = 1) {
  const a = before.split("\n");
  const b = after.split("\n");
  // LCS table; block modules are small.
  const m = a.length;
  const n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let x = m - 1; x >= 0; x--) {
    for (let y = n - 1; y >= 0; y--) {
      lcs[x][y] = a[x] === b[y] ? lcs[x + 1][y + 1] + 1 : Math.max(lcs[x + 1][y], lcs[x][y + 1]);
    }
  }
  const ops = [];
  let x = 0;
  let y = 0;
  while (x < m || y < n) {
    if (x < m && y < n && a[x] === b[y]) {
      ops.push({ op: " ", line: a[x] });
      x++;
      y++;
    } else if (x < m && (y >= n || lcs[x + 1][y] >= lcs[x][y + 1]))
      ops.push({ op: "-", line: a[x++] });
    else ops.push({ op: "+", line: b[y++] });
  }
  // Number every op with its positions, then group changes with context.
  let ai = 1;
  let bi = 1;
  const numbered = ops.map((o) => {
    const r = { ...o, a: ai, b: bi };
    if (o.op !== "+") ai++;
    if (o.op !== "-") bi++;
    return r;
  });
  const hunks = [];
  for (let k = 0; k < numbered.length; k++) {
    if (numbered[k].op === " ") continue;
    const start = Math.max(0, k - context);
    let end = k;
    while (end + 1 < numbered.length) {
      const gap = numbered.slice(end + 1, end + 1 + 2 * context + 1);
      const nextChange = gap.findIndex((o) => o.op !== " ");
      if (nextChange === -1) break;
      end = end + 1 + nextChange;
    }
    const stop = Math.min(numbered.length - 1, end + context);
    const slice = numbered.slice(start, stop + 1);
    const aCount = slice.filter((o) => o.op !== "+").length;
    const bCount = slice.filter((o) => o.op !== "-").length;
    const range = (from, count) => (count === 1 ? `${from}` : `${from},${count}`);
    hunks.push(
      `@@ -${range(slice[0].a, aCount)} +${range(slice[0].b, bCount)} @@\n${slice.map((o) => `${o.op}${o.line}`).join("\n")}`,
    );
    k = stop;
  }
  return hunks.join("\n");
}
