/** Lightweight SQL pretty-print + tokenize for pipeline UI (no heavy editor). */

export type SqlTokenKind = "kw" | "str" | "num" | "id" | "punct" | "ws" | "text";

export type SqlToken = { kind: SqlTokenKind; value: string };

const KEYWORDS = new Set(
  [
    "WITH",
    "AS",
    "SELECT",
    "FROM",
    "WHERE",
    "GROUP",
    "BY",
    "HAVING",
    "ORDER",
    "LIMIT",
    "OFFSET",
    "JOIN",
    "INNER",
    "LEFT",
    "RIGHT",
    "FULL",
    "CROSS",
    "OUTER",
    "ON",
    "AND",
    "OR",
    "NOT",
    "IN",
    "IS",
    "NULL",
    "TRUE",
    "FALSE",
    "UNION",
    "ALL",
    "DISTINCT",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "ASC",
    "DESC",
    "BETWEEN",
    "LIKE",
    "EXISTS",
    "CAST",
  ].map((k) => k.toUpperCase()),
);

/** Multi-word clause heads that should start a new line (longest match first). */
const CLAUSE_STARTS: string[][] = [
  ["GROUP", "BY"],
  ["ORDER", "BY"],
  ["UNION", "ALL"],
  ["INNER", "JOIN"],
  ["LEFT", "OUTER", "JOIN"],
  ["RIGHT", "OUTER", "JOIN"],
  ["FULL", "OUTER", "JOIN"],
  ["LEFT", "JOIN"],
  ["RIGHT", "JOIN"],
  ["FULL", "JOIN"],
  ["CROSS", "JOIN"],
  ["JOIN"],
  ["SELECT"],
  ["FROM"],
  ["WHERE"],
  ["HAVING"],
  ["LIMIT"],
  ["OFFSET"],
  ["ON"],
  ["UNION"],
  ["WITH"],
];

function isWordChar(c: string) {
  return /[A-Za-z0-9_]/.test(c);
}

/** Lex SQL into tokens; returns null if quotes are unbalanced. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i + 1;
      while (j < n && /[ \t\n\r]/.test(sql[j])) j++;
      tokens.push({ kind: "ws", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === quote) {
          if (j + 1 < n && sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        // Unbalanced — return a single text token so callers can fall back.
        return [{ kind: "text", value: sql }];
      }
      tokens.push({
        kind: quote === "'" ? "str" : "id",
        value: sql.slice(i, j),
      });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(sql[j])) j++;
      tokens.push({ kind: "num", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (isWordChar(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j])) j++;
      const word = sql.slice(i, j);
      tokens.push({
        kind: KEYWORDS.has(word.toUpperCase()) ? "kw" : "text",
        value: word,
      });
      i = j;
      continue;
    }

    tokens.push({ kind: "punct", value: c });
    i++;
  }

  return tokens;
}

function meaningful(tokens: SqlToken[]) {
  return tokens.filter((t) => t.kind !== "ws");
}

function matchClause(
  words: SqlToken[],
  index: number,
): { length: number; label: string } | null {
  const upper = (t: SqlToken) => t.value.toUpperCase();
  for (const parts of CLAUSE_STARTS) {
    if (index + parts.length > words.length) continue;
    let ok = true;
    for (let k = 0; k < parts.length; k++) {
      const t = words[index + k];
      if (t.kind !== "kw" && t.kind !== "text") {
        ok = false;
        break;
      }
      if (upper(t) !== parts[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return { length: parts.length, label: parts.join(" ") };
  }
  return null;
}

function indent(level: number) {
  return "  ".repeat(Math.max(0, level));
}

/**
 * Pretty-print SQL for display/editing. On failure (e.g. unbalanced quotes),
 * returns the original string unchanged.
 */
export function beautifySql(sql: string): string {
  if (!sql.trim()) return sql;
  if (!isBalancedQuotes(sql)) return sql;

  const words = meaningful(tokenizeSql(sql));
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  let atLineStart = true;
  let afterWith = false;
  let pendingCommaNewline = false;

  const emit = (chunk: string, { softSpace = true } = {}) => {
    if (!chunk) return;
    if (pendingCommaNewline) {
      out.push("\n" + indent(depth + (afterWith ? 1 : 0)));
      pendingCommaNewline = false;
      atLineStart = true;
    }
    const prev = out[out.length - 1] ?? "";
    if (
      softSpace &&
      !atLineStart &&
      out.length &&
      !/[\s(.]$/.test(prev) &&
      !/^[,).]/.test(chunk)
    ) {
      out.push(" ");
    }
    out.push(chunk);
    atLineStart = false;
  };

  const newline = (level = depth) => {
    out.push("\n" + indent(level));
    atLineStart = true;
  };

  while (i < words.length) {
    const t = words[i];

    if (t.kind === "punct" && t.value === "(") {
      emit("(", { softSpace: true });
      depth++;
      // Break after AS ( for CTE bodies / subqueries when content follows
      const next = words[i + 1];
      if (next && !(next.kind === "punct" && next.value === ")")) {
        newline(depth);
      }
      i++;
      continue;
    }

    if (t.kind === "punct" && t.value === ")") {
      depth = Math.max(0, depth - 1);
      if (!atLineStart) newline(depth);
      else if (out.length && out[out.length - 1]?.startsWith("\n")) {
        out[out.length - 1] = "\n" + indent(depth);
      }
      emit(")", { softSpace: false });
      i++;
      continue;
    }

    if (t.kind === "punct" && t.value === ",") {
      emit(",", { softSpace: false });
      if (afterWith && depth === 0) {
        pendingCommaNewline = true;
      } else if (depth > 0) {
        // keep SELECT lists compact unless very long — still break for readability
        pendingCommaNewline = false;
        emit(" ", { softSpace: false });
      }
      i++;
      continue;
    }

    if (t.kind === "punct") {
      emit(t.value, {
        softSpace: ![".", ",", ")", "("].includes(t.value),
      });
      i++;
      continue;
    }

    const clause = matchClause(words, i);
    if (clause) {
      const label = clause.label;

      if (label === "WITH") {
        afterWith = true;
        if (!atLineStart) newline(depth);
        emit("WITH", { softSpace: false });
        newline(depth + 1);
        i += clause.length;
        continue;
      }

      const breakLine = [
        "SELECT",
        "FROM",
        "WHERE",
        "GROUP BY",
        "HAVING",
        "ORDER BY",
        "LIMIT",
        "OFFSET",
        "JOIN",
        "INNER JOIN",
        "LEFT JOIN",
        "RIGHT JOIN",
        "FULL JOIN",
        "CROSS JOIN",
        "LEFT OUTER JOIN",
        "RIGHT OUTER JOIN",
        "FULL OUTER JOIN",
        "ON",
        "UNION",
        "UNION ALL",
      ].includes(label);

      if (breakLine) {
        if (afterWith && depth === 0 && label === "SELECT") {
          afterWith = false;
        }
        if (!atLineStart) newline(depth);
        emit(label, { softSpace: false });
        i += clause.length;
        continue;
      }

      emit(label, { softSpace: true });
      i += clause.length;
      continue;
    }

    // Lone AS keyword
    if (t.kind === "kw" && t.value.toUpperCase() === "AS") {
      emit("AS", { softSpace: true });
      i++;
      continue;
    }

    emit(t.value, { softSpace: true });
    i++;
  }

  // Collapse excessive blank-ish lines and trim trailing space on each line
  const formatted = out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return formatted;
}

function isBalancedQuotes(sql: string): boolean {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === q) {
          if (i + 1 < sql.length && sql[i + 1] === q) {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return false;
      continue;
    }
    i++;
  }
  return true;
}
