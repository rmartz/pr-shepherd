// ---------------------------------------------------------------------------
// Routing DSL parser (vision §4.4).
//
// Parses a single condition string into a small AST that the evaluator can
// walk. **No `eval`, no Function constructor, no sandboxed JS** — every
// expression is recognized by an explicit recursive-descent parser, so the
// set of supported operations is exactly what the grammar below describes.
//
// Grammar (precedence low → high):
//
//   expr      ::= orExpr
//   orExpr    ::= andExpr ('||' andExpr)*
//   andExpr   ::= unaryExpr ('&&' unaryExpr)*
//   unaryExpr ::= '!' unaryExpr | equality
//   equality  ::= primary (('==' | '!=') primary)?
//   primary   ::= boolLit | numLit | strLit | fieldAccess | '(' expr ')'
//   boolLit   ::= 'true' | 'false'
//   strLit    ::= "'" <any-except-single-quote>* "'"
//   numLit    ::= [0-9]+ ('.' [0-9]+)?
//   fieldAccess ::= ('output' | 'context') ('.' identifier)*
//   identifier ::= [A-Za-z_][A-Za-z0-9_]*
//
// The only valid identifier roots are `output` and `context`. A bare
// identifier or a foreign root (e.g. `verdict.x`) is a parse error here so
// the workflow loader (separate sub-issue) catches it at load time rather
// than failing only at evaluation time on the unlucky run that exercises
// that branch.
// ---------------------------------------------------------------------------

export type ConditionAst =
  | { kind: "bool"; value: boolean }
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "field"; root: "context" | "output"; path: string[] }
  | { kind: "not"; expr: ConditionAst }
  | {
      kind: "binary";
      op: "!=" | "&&" | "==" | "||";
      left: ConditionAst;
      right: ConditionAst;
    };

const VALID_ROOTS = new Set(["context", "output"]);

// --- Tokenizer -------------------------------------------------------------

type TokenKind =
  | "andand"
  | "bang"
  | "bool"
  | "dot"
  | "eq"
  | "ident"
  | "lparen"
  | "neq"
  | "num"
  | "oror"
  | "rparen"
  | "str";

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    const start = i;
    if (ch === "(") {
      tokens.push({ kind: "lparen", value: "(", pos: start });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", value: ")", pos: start });
      i += 1;
      continue;
    }
    if (ch === ".") {
      tokens.push({ kind: "dot", value: ".", pos: start });
      i += 1;
      continue;
    }
    if (ch === "=" && source[i + 1] === "=") {
      tokens.push({ kind: "eq", value: "==", pos: start });
      i += 2;
      continue;
    }
    if (ch === "!" && source[i + 1] === "=") {
      tokens.push({ kind: "neq", value: "!=", pos: start });
      i += 2;
      continue;
    }
    if (ch === "!") {
      tokens.push({ kind: "bang", value: "!", pos: start });
      i += 1;
      continue;
    }
    if (ch === "&" && source[i + 1] === "&") {
      tokens.push({ kind: "andand", value: "&&", pos: start });
      i += 2;
      continue;
    }
    if (ch === "|" && source[i + 1] === "|") {
      tokens.push({ kind: "oror", value: "||", pos: start });
      i += 2;
      continue;
    }
    if (ch === "'") {
      // Single-quoted string literal. No escape support — workflow
      // conditions are short and the YAML layer can already quote strings.
      i += 1;
      const strStart = i;
      while (i < source.length && source[i] !== "'") i += 1;
      if (i >= source.length) {
        throw new Error(
          `Unterminated string literal starting at position ${String(start)}.`,
        );
      }
      const value = source.slice(strStart, i);
      i += 1; // consume closing quote
      tokens.push({ kind: "str", value, pos: start });
      continue;
    }
    if (ch !== undefined && /[0-9]/.test(ch)) {
      while (i < source.length && /[0-9]/.test(source[i] ?? "")) i += 1;
      if (source[i] === "." && /[0-9]/.test(source[i + 1] ?? "")) {
        i += 1;
        while (i < source.length && /[0-9]/.test(source[i] ?? "")) i += 1;
      }
      const value = source.slice(start, i);
      // Reject malformed literals like `1.2.3` — the next character must
      // not extend a second fractional part. Without this guard, the
      // tokenizer would greedily slurp the trailing `.3` into the
      // identifier path and Number("1.2.3") would silently become NaN,
      // which compares unequal to every concrete value and quietly
      // masks the parse error at evaluation time.
      if (source[i] === "." && /[0-9]/.test(source[i + 1] ?? "")) {
        throw new Error(
          `Malformed numeric literal "${value}." at position ${String(start)} — at most one decimal point is allowed.`,
        );
      }
      tokens.push({ kind: "num", value, pos: start });
      continue;
    }
    if (ch !== undefined && /[A-Za-z_]/.test(ch)) {
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] ?? "")) i += 1;
      const value = source.slice(start, i);
      if (value === "true" || value === "false") {
        tokens.push({ kind: "bool", value, pos: start });
      } else {
        tokens.push({ kind: "ident", value, pos: start });
      }
      continue;
    }
    throw new Error(
      `Unexpected character "${ch ?? ""}" at position ${String(start)}.`,
    );
  }
  return tokens;
}

// --- Recursive-descent parser ----------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): ConditionAst {
    const expr = this.parseOr();
    if (this.pos !== this.tokens.length) {
      const t = this.tokens[this.pos];
      throw new Error(
        `Unexpected token "${t?.value ?? ""}" at position ${posLabel(t?.pos)}.`,
      );
    }
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(kind: TokenKind): Token {
    const t = this.tokens[this.pos];
    if (t?.kind !== kind) {
      throw new Error(
        `Expected ${kind} but found "${t?.value ?? "<end>"}" at position ${posLabel(t?.pos)}.`,
      );
    }
    this.pos += 1;
    return t;
  }

  private parseOr(): ConditionAst {
    let left = this.parseAnd();
    while (this.peek()?.kind === "oror") {
      this.pos += 1;
      const right = this.parseAnd();
      left = { kind: "binary", op: "||", left, right };
    }
    return left;
  }

  private parseAnd(): ConditionAst {
    let left = this.parseUnary();
    while (this.peek()?.kind === "andand") {
      this.pos += 1;
      const right = this.parseUnary();
      left = { kind: "binary", op: "&&", left, right };
    }
    return left;
  }

  private parseUnary(): ConditionAst {
    if (this.peek()?.kind === "bang") {
      this.pos += 1;
      return { kind: "not", expr: this.parseUnary() };
    }
    return this.parseEquality();
  }

  private parseEquality(): ConditionAst {
    const left = this.parsePrimary();
    const next = this.peek();
    if (next?.kind === "eq" || next?.kind === "neq") {
      this.pos += 1;
      const right = this.parsePrimary();
      return {
        kind: "binary",
        op: next.kind === "eq" ? "==" : "!=",
        left,
        right,
      };
    }
    return left;
  }

  private parsePrimary(): ConditionAst {
    const t = this.peek();
    if (t === undefined) {
      throw new Error("Unexpected end of expression.");
    }
    if (t.kind === "lparen") {
      this.pos += 1;
      const inner = this.parseOr();
      this.consume("rparen");
      return inner;
    }
    if (t.kind === "bool") {
      this.pos += 1;
      return { kind: "bool", value: t.value === "true" };
    }
    if (t.kind === "num") {
      this.pos += 1;
      return { kind: "num", value: Number(t.value) };
    }
    if (t.kind === "str") {
      this.pos += 1;
      return { kind: "str", value: t.value };
    }
    if (t.kind === "ident") {
      if (!VALID_ROOTS.has(t.value)) {
        throw new Error(
          `Unknown identifier "${t.value}" at position ${String(t.pos)}. Conditions may reference only \`output\` and \`context\`.`,
        );
      }
      const root = t.value as "context" | "output";
      this.pos += 1;
      const path: string[] = [];
      while (this.peek()?.kind === "dot") {
        this.pos += 1;
        const field = this.consume("ident");
        path.push(field.value);
      }
      return { kind: "field", root, path };
    }
    throw new Error(
      `Unexpected token "${t.value}" at position ${String(t.pos)}.`,
    );
  }
}

function posLabel(pos: number | undefined): string {
  return pos === undefined ? "end" : String(pos);
}

export function parseCondition(source: string): ConditionAst {
  return new Parser(tokenize(source)).parse();
}
