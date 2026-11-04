/**
 * A small tokenizer over TS/TSX source: enough to find one array literal's
 * closing bracket and the top-level imports, without a parser (spec 41 decision 10:
 * TypeScript's own API is `./unstable/*` on the major the workspace uses, and a
 * host may have either major).
 *
 * It knows strings, template literals (with `${}` nesting), both comment forms and
 * regular expression literals, so a bracket inside any of them is not a bracket.
 * Two concessions to TSX, both local to one line: `</` is a closing tag rather
 * than a regex, and a quote string ends at a newline, so an apostrophe in JSX text
 * cannot swallow the rest of the file. The callers refuse anything they do not
 * match exactly once, so a misread costs a manual edit, never a wrong one.
 *
 * @typedef {{ t: "id" | "p" | "str" | "tpl" | "num" | "re", v: string, s: number, e: number, depth: number, open?: number, close?: number }} Token
 *   `depth` is the bracket depth the token sits at (an opening bracket at its
 *   outer depth). `close` on an opening bracket, and `open` on a closing one, is
 *   the index of its partner.
 */

const PUNCT = [
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);
const OPEN = { "(": ")", "[": "]", "{": "}" };

/** @returns {Token[]} */
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  const push = (t, s, e) => tokens.push({ t, v: src.slice(s, e), s, e, depth: 0 });

  const skipQuote = (start) => {
    const q = src[start];
    let j = start + 1;
    while (j < n && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, n);
  };
  const skipTemplate = (start) => {
    let j = start + 1;
    while (j < n && src[j] !== "`") {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "$" && src[j + 1] === "{") j = skipBraces(j + 1);
      else j++;
    }
    return Math.min(j + 1, n);
  };
  /** From an opening `{` to just past its partner, skipping strings and comments. */
  const skipBraces = (start) => {
    let depth = 0;
    let j = start;
    while (j < n) {
      const c = src[j];
      if (c === '"' || c === "'") j = skipQuote(j);
      else if (c === "`") j = skipTemplate(j);
      else if (c === "/" && src[j + 1] === "/") j = lineEnd(j);
      else if (c === "/" && src[j + 1] === "*") j = blockEnd(j);
      else {
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) return j + 1;
        j++;
      }
    }
    return n;
  };
  const lineEnd = (j) => {
    const k = src.indexOf("\n", j);
    return k === -1 ? n : k;
  };
  const blockEnd = (j) => {
    const k = src.indexOf("*/", j + 2);
    return k === -1 ? n : k + 2;
  };
  const regexAllowed = () => {
    const prev = tokens.at(-1);
    if (!prev) return true;
    if (prev.t === "id") return REGEX_AFTER_WORD.has(prev.v);
    if (prev.t === "p") return ![")", "]", "}", "<"].includes(prev.v);
    return false;
  };

  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      i = lineEnd(i);
    } else if (c === "/" && src[i + 1] === "*") {
      i = blockEnd(i);
    } else if (c === '"' || c === "'") {
      const e = skipQuote(i);
      push("str", i, e);
      i = e;
    } else if (c === "`") {
      const e = skipTemplate(i);
      push("tpl", i, e);
      i = e;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      push("id", i, j);
      i = j;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      push("num", i, j);
      i = j;
    } else if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "[") (inClass = true), j++;
        else if (src[j] === "]") (inClass = false), j++;
        else if (src[j] === "/" && !inClass) break;
        else j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      push("re", i, j);
      i = j;
    } else {
      const op = PUNCT.find((p) => src.startsWith(p, i)) ?? c;
      push("p", i, i + op.length);
      i += op.length;
    }
  }

  // Depths and partners.
  const stack = [];
  tokens.forEach((tok, k) => {
    tok.depth = stack.length;
    if (tok.t !== "p") return;
    if (OPEN[tok.v]) stack.push(k);
    else if (tok.v === ")" || tok.v === "]" || tok.v === "}") {
      const top = stack.at(-1);
      if (top !== undefined && OPEN[tokens[top].v] === tok.v) {
        stack.pop();
        tok.depth = stack.length;
        tok.open = top;
        tokens[top].close = k;
      }
    }
  });
  return tokens;
}

/** A string token's value without its quotes, and the quote character. */
export function stringValue(tok) {
  return { value: tok.v.slice(1, -1), quote: tok.v[0] };
}

/** The whitespace that starts the line containing `offset`. */
export function indentAt(src, offset) {
  const start = src.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(src.slice(start))[0];
}

/** Whether `src` between two offsets holds a newline. */
export function spansLines(src, from, to) {
  return src.slice(from, to).includes("\n");
}
