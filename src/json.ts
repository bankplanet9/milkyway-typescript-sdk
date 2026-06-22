import { Decimal } from "decimal.js";

/**
 * `JSON.parse` coerces every number to an IEEE-754 float64, which silently
 * loses precision on monetary values (e.g. large amounts or rates with many
 * significant digits). To keep money exact we never let `JSON.parse` produce
 * the number for a money field: we pre-scan the raw source for the money keys,
 * pull out their exact digit strings, and substitute a string sentinel that
 * survives `JSON.parse` losslessly. A reviver then rebuilds an exact
 * {@link Decimal} from the original digits — never from a float64 round-trip.
 *
 * The set of money fields is fixed by the API contract:
 * `amount_credit`, `amount_debit`, `rate`, `commission`.
 */
const MONEY_KEYS = new Set(["amount_credit", "amount_debit", "rate", "commission"]);

/** Sentinel marker; contains only regex-safe, JSON-safe characters. */
const PREFIX = "MWDEC_SENTINEL_";

/**
 * Parses an API JSON response, materialising money fields as {@link Decimal}
 * with full precision. Non-money numbers (ids, status codes) stay as `number`.
 */
export function parseJson(text: string): any {
  const sentinels: string[] = [];

  const keyAlternation = [...MONEY_KEYS].join("|");
  // Matches `"<moneyKey>": <jsonNumber>` and captures the exact numeric literal.
  const re = new RegExp(
    `("(?:${keyAlternation})"\\s*:\\s*)(-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
    "g",
  );

  const transformed = text.replace(re, (_match, keyPart: string, numLiteral: string) => {
    const idx = sentinels.push(numLiteral) - 1;
    return `${keyPart}${JSON.stringify(`${PREFIX}${idx}`)}`;
  });

  return JSON.parse(transformed, (_key, value) => {
    if (typeof value === "string" && value.startsWith(PREFIX)) {
      const idx = Number(value.slice(PREFIX.length));
      return new Decimal(sentinels[idx] as string);
    }
    return value;
  });
}

/**
 * Serialises a request payload to JSON. {@link Decimal} money values are
 * emitted as bare JSON numbers (the API expects numbers, not strings) via a
 * sentinel substitution that bypasses `JSON.stringify`'s quoting.
 */
export function stringifyJson(value: unknown): string {
  const literals: string[] = [];

  // Pre-walk to swap Decimal instances for string sentinels BEFORE
  // JSON.stringify runs. A replacer can't see Decimals directly: decimal.js
  // defines `toJSON`, so the replacer would receive an already-stringified
  // value. Each sentinel records the exact `toFixed()` digit string.
  const swap = (v: unknown): unknown => {
    if (v instanceof Decimal) {
      const idx = literals.push(v.toFixed()) - 1;
      return `${PREFIX}${idx}`;
    }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = swap(val);
      return out;
    }
    return v;
  };

  const json = JSON.stringify(swap(value));

  // Unwrap the quoted sentinels back into bare numeric literals.
  return json.replace(
    new RegExp(`"${PREFIX}(\\d+)"`, "g"),
    (_m, idx: string) => literals[Number(idx)] as string,
  );
}
