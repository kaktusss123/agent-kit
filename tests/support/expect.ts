/**
 * Value assertions for the extension tests on the Node.js test runner.
 *
 * `node:test` supplies the structure (suites, cases, hooks, skip options) but
 * no value-assertion surface, and the extension tests are written against the
 * Jest-shaped matchers they used before. This module is that surface and
 * nothing else: no runner, no globals, no transpilation. Semantics follow the
 * runner the tests were written on so the scenarios keep their meaning:
 *
 *   toBe           Object.is (so NaN equals NaN and 0 does not equal -0)
 *   toEqual        structural, own enumerable string and symbol keys,
 *                  properties whose value is undefined are ignored,
 *                  Date/RegExp/Map/Set/typed arrays/Error compared by content,
 *                  class identity is not compared
 *   toContain      strict equality for arrays, substring for strings
 *   toMatchObject  recursive subset; arrays must have equal length and every
 *                  expected key must be present on the actual value
 *
 * Failures throw an AssertionError whose message names the matcher, the
 * actual value and the expectation.
 */
import { inspect } from "node:util";

const ASYMMETRIC = Symbol("agent-kit.asymmetric");

interface AsymmetricMatcher {
  readonly [ASYMMETRIC]: true;
  matches(actual: unknown): boolean;
  describe(): string;
}

function isAsymmetric(value: unknown): value is AsymmetricMatcher {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[ASYMMETRIC] === true;
}

class AnyMatcher implements AsymmetricMatcher {
  readonly [ASYMMETRIC] = true as const;
  private readonly expected: unknown;
  constructor(expected: unknown) {
    this.expected = expected;
  }
  matches(actual: unknown): boolean {
    return this.expected === String
      ? typeof actual === "string" || actual instanceof String
      : this.expected === Number
        ? typeof actual === "number" || actual instanceof Number
        : this.expected === Boolean
          ? typeof actual === "boolean" || actual instanceof Boolean
          : this.expected === Function
            ? typeof actual === "function"
            : this.expected === Object
              ? actual !== null && typeof actual === "object"
              : typeof this.expected === "function"
                ? actual instanceof (this.expected as new (...args: never[]) => unknown)
                : false;
  }
  describe(): string {
    const ctor = this.expected as { name?: string } | undefined;
    return `Any<${ctor?.name ?? String(this.expected)}>`;
  }
}

class AnythingMatcher implements AsymmetricMatcher {
  readonly [ASYMMETRIC] = true as const;
  matches(actual: unknown): boolean {
    return actual !== null && actual !== undefined;
  }
  describe(): string {
    return "Anything";
  }
}

class StringContainingMatcher implements AsymmetricMatcher {
  readonly [ASYMMETRIC] = true as const;
  private readonly expected: string;
  constructor(expected: string) {
    this.expected = expected;
  }
  matches(actual: unknown): boolean {
    return typeof actual === "string" && actual.includes(this.expected);
  }
  describe(): string {
    return `StringContaining ${inspect(this.expected)}`;
  }
}

class StringMatchingMatcher implements AsymmetricMatcher {
  readonly [ASYMMETRIC] = true as const;
  private readonly expected: RegExp | string;
  constructor(expected: RegExp | string) {
    this.expected = expected;
  }
  matches(actual: unknown): boolean {
    if (typeof actual !== "string") return false;
    const pattern = this.expected instanceof RegExp ? this.expected : new RegExp(this.expected);
    return pattern.test(actual);
  }
  describe(): string {
    return `StringMatching ${String(this.expected)}`;
  }
}

function ownEnumerableKeys(value: object): (string | symbol)[] {
  const keys: (string | symbol)[] = Object.keys(value);
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, symbol)) keys.push(symbol);
  }
  return keys;
}

/** Structural equality with the semantics the tests rely on. */
function equals(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (isAsymmetric(actual)) return actual.matches(expected);
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== typeof expected) return false;
  if (actual === null || expected === null) return false;
  if (typeof actual !== "object" && typeof actual !== "function") return false;
  if (typeof actual === "function" || typeof expected === "function") return false;

  if (actual instanceof Date || expected instanceof Date) {
    return actual instanceof Date && expected instanceof Date && Object.is(actual.getTime(), expected.getTime());
  }
  if (actual instanceof RegExp || expected instanceof RegExp) {
    return actual instanceof RegExp && expected instanceof RegExp && actual.source === expected.source && actual.flags === expected.flags;
  }
  if (actual instanceof Error || expected instanceof Error) {
    if (!(actual instanceof Error) || !(expected instanceof Error)) return false;
    if (actual.constructor !== expected.constructor) return false;
    if (actual.name !== expected.name || actual.message !== expected.message) return false;
    return equalKeys(actual, expected, () => true);
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (actual instanceof Map || expected instanceof Map) {
    if (!(actual instanceof Map) || !(expected instanceof Map)) return false;
    if (actual.size !== expected.size) return false;
    const remaining = [...expected.entries()];
    for (const [key, value] of actual.entries()) {
      const index = remaining.findIndex(([candidate]) => equals(key, candidate));
      if (index === -1) return false;
      const [candidateKey, candidateValue] = remaining[index];
      if (!equals(key, candidateKey) || !equals(value, candidateValue)) return false;
      remaining.splice(index, 1);
    }
    return true;
  }
  if (actual instanceof Set || expected instanceof Set) {
    if (!(actual instanceof Set) || !(expected instanceof Set)) return false;
    if (actual.size !== expected.size) return false;
    const remaining = [...expected];
    for (const value of actual) {
      const index = remaining.findIndex((candidate) => equals(value, candidate));
      if (index === -1) return false;
      remaining.splice(index, 1);
    }
    return true;
  }
  if (ArrayBuffer.isView(actual) || ArrayBuffer.isView(expected)) {
    if (!ArrayBuffer.isView(actual) || !ArrayBuffer.isView(expected)) return false;
    if (actual.constructor !== expected.constructor) return false;
    const left = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
    const right = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return false;
    return actual.every((value, index) => equals(value, expected[index]));
  }
  return equalKeys(actual as object, expected as object, (value) => value !== undefined);
}

function equalKeys(actual: object, expected: object, keep: (value: unknown) => boolean): boolean {
  const actualKeys = ownEnumerableKeys(actual).filter((key) => keep((actual as Record<string | symbol, unknown>)[key]));
  const expectedKeys = ownEnumerableKeys(expected).filter((key) => keep((expected as Record<string | symbol, unknown>)[key]));
  if (actualKeys.length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    if (!actualKeys.includes(key)) return false;
    if (!equals((actual as Record<string | symbol, unknown>)[key], (expected as Record<string | symbol, unknown>)[key])) return false;
  }
  return true;
}

/** Recursive subset match: every expected key must exist on the actual value. */
function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (expected instanceof Date) return actual instanceof Date && Object.is(actual.getTime(), expected.getTime());
  if (expected instanceof RegExp) return actual instanceof RegExp && actual.source === expected.source && actual.flags === expected.flags;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((value, index) => matchesSubset(actual[index], value));
  }
  for (const key of Object.keys(expected)) {
    if (!(key in (actual as object))) return false;
    if (!matchesSubset((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** Parse a property path such as `a.b[1].c` into its segments. */
function propertyPath(path: string): string[] {
  const segments: string[] = [];
  for (const part of path.split(".")) {
    const match = /^([^[\]]*)((?:\[[^[\]]*\])*)$/.exec(part);
    if (!match) {
      segments.push(part);
      continue;
    }
    if (match[1] !== "") segments.push(match[1]);
    for (const indexed of match[2].match(/\[[^[\]]*\]/g) ?? []) segments.push(indexed.slice(1, -1).replace(/^['"]|['"]$/g, ""));
  }
  return segments;
}

function hasProperty(actual: unknown, path: string): { found: boolean; value?: unknown } {
  let current: unknown = actual;
  for (const segment of propertyPath(path)) {
    if (current === null || current === undefined) return { found: false };
    if (!(segment in Object(current))) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function show(value: unknown): string {
  return inspect(value, { depth: 6, breakLength: 120, compact: true });
}

function describeExpected(value: unknown): string {
  return isAsymmetric(value) ? value.describe() : show(value);
}

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

type Check = (actual: unknown, args: unknown[]) => string | null;

/** Each check returns a failure explanation, or null when the matcher holds. */
function matcher(name: string, check: Check): [string, Check] {
  return [name, check];
}

const MATCHERS = Object.fromEntries([
  matcher("toBe", (actual, [expected]) => (Object.is(actual, expected) ? null : `expected ${show(actual)} to be ${show(expected)}`)),
  matcher("toEqual", (actual, [expected]) => (equals(actual, expected) ? null : `expected ${show(actual)} to equal ${describeExpected(expected)}`)),
  matcher("toStrictEqual", (actual, [expected]) => (equals(actual, expected) ? null : `expected ${show(actual)} to strictly equal ${show(expected)}`)),
  matcher("toContain", (actual, [expected]) =>
    typeof actual === "string"
      ? typeof expected === "string" && actual.includes(expected)
        ? null
        : `expected ${show(actual)} to contain ${show(expected)}`
      : Array.isArray(actual) && (actual as unknown[]).some((value) => value === expected)
        ? null
        : `expected ${show(actual)} to contain ${show(expected)}`,
  ),
  matcher("toMatchObject", (actual, [expected]) =>
    matchesSubset(actual, expected) ? null : `expected ${show(actual)} to match object ${show(expected)}`,
  ),
  matcher("toMatch", (actual, [expected]) => {
    if (typeof actual !== "string") return `expected a string to match ${String(expected)}, got ${show(actual)}`;
    const matches = expected instanceof RegExp ? expected.test(actual) : actual.includes(String(expected));
    return matches ? null : `expected ${show(actual)} to match ${String(expected)}`;
  }),
  matcher("toBeUndefined", (actual) => (actual === undefined ? null : `expected ${show(actual)} to be undefined`)),
  matcher("toBeDefined", (actual) => (actual !== undefined ? null : "expected a value to be defined, got undefined")),
  matcher("toBeNull", (actual) => (actual === null ? null : `expected ${show(actual)} to be null`)),
  matcher("toBeTruthy", (actual) => (actual ? null : `expected ${show(actual)} to be truthy`)),
  matcher("toBeFalsy", (actual) => (actual ? `expected ${show(actual)} to be falsy` : null)),
  matcher("toBeNumber", (actual) => (typeof actual === "number" ? null : `expected ${show(actual)} to be a number`)),
  matcher("toBeInstanceOf", (actual, [expected]) =>
    typeof expected === "function" && actual instanceof (expected as new (...args: never[]) => unknown)
      ? null
      : `expected ${show(actual)} to be an instance of ${(expected as { name?: string })?.name ?? String(expected)}`,
  ),
  matcher("toBeGreaterThan", (actual, [expected]) =>
    (actual as number) > (expected as number) ? null : `expected ${show(actual)} to be greater than ${show(expected)}`,
  ),
  matcher("toBeGreaterThanOrEqual", (actual, [expected]) =>
    (actual as number) >= (expected as number) ? null : `expected ${show(actual)} to be at least ${show(expected)}`,
  ),
  matcher("toBeLessThan", (actual, [expected]) =>
    (actual as number) < (expected as number) ? null : `expected ${show(actual)} to be less than ${show(expected)}`,
  ),
  matcher("toBeLessThanOrEqual", (actual, [expected]) =>
    (actual as number) <= (expected as number) ? null : `expected ${show(actual)} to be at most ${show(expected)}`,
  ),
  matcher("toBeCloseTo", (actual, [expected, digits]) => {
    const precision = typeof digits === "number" ? digits : 2;
    return Math.abs((actual as number) - (expected as number)) < Math.pow(10, -precision) / 2
      ? null
      : `expected ${show(actual)} to be close to ${show(expected)} (${precision} digits)`;
  }),
  matcher("toStartWith", (actual, [expected]) =>
    typeof actual === "string" && actual.startsWith(String(expected))
      ? null
      : `expected ${show(actual)} to start with ${show(expected)}`,
  ),
  matcher("toHaveLength", (actual, [expected]) => {
    const length = (actual as { length?: unknown } | null)?.length;
    return length === expected ? null : `expected length ${show(length)} to be ${show(expected)} in ${show(actual)}`;
  }),
  matcher("toHaveProperty", (actual, args) => {
    const [path, ...rest] = args;
    const result = hasProperty(actual, String(path));
    if (!result.found) return `expected ${show(actual)} to have property ${show(path)}`;
    if (rest.length === 0) return null;
    return equals(result.value, rest[0])
      ? null
      : `expected property ${show(path)} of ${show(actual)} to equal ${describeExpected(rest[0])}, got ${show(result.value)}`;
  }),
  matcher("toThrow", (actual, args) => {
    if (typeof actual !== "function") return `expected a function to throw, got ${show(actual)}`;
    let thrown = false;
    let error: unknown;
    try {
      (actual as () => unknown)();
    } catch (caught) {
      thrown = true;
      error = caught;
    }
    if (!thrown) return `expected the function to throw${args.length > 0 ? ` ${describeExpected(args[0])}` : ""}`;
    if (args.length === 0 || args[0] === undefined) return null;
    const expected = args[0];
    if (typeof expected === "string") {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes(expected) ? null : `expected the thrown message ${show(message)} to contain ${show(expected)}`;
    }
    if (expected instanceof RegExp) {
      const message = error instanceof Error ? error.message : String(error);
      return expected.test(message) ? null : `expected the thrown message ${show(message)} to match ${String(expected)}`;
    }
    if (typeof expected === "function") {
      return error instanceof (expected as new (...args: never[]) => unknown)
        ? null
        : `expected the thrown value ${show(error)} to be an instance of ${(expected as { name?: string }).name}`;
    }
    return equals(error, expected) ? null : `expected the thrown value ${show(error)} to equal ${show(expected)}`;
  }),
] as [string, Check][]);

export interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toMatchObject(expected: unknown): void;
  toMatch(expected: RegExp | string): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNumber(): void;
  toBeInstanceOf(expected: unknown): void;
  toBeGreaterThan(expected: number | string | bigint): void;
  toBeGreaterThanOrEqual(expected: number | string | bigint): void;
  toBeLessThan(expected: number | string | bigint): void;
  toBeLessThanOrEqual(expected: number | string | bigint): void;
  toBeCloseTo(expected: number, digits?: number): void;
  toStartWith(expected: string): void;
  toHaveLength(expected: number): void;
  toHaveProperty(path: string, ...value: unknown[]): void;
  toThrow(expected?: unknown): void;
}

export interface AsyncMatchers {
  toBe(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
  toStrictEqual(expected: unknown): Promise<void>;
  toContain(expected: unknown): Promise<void>;
  toMatchObject(expected: unknown): Promise<void>;
  toMatch(expected: RegExp | string): Promise<void>;
  toBeUndefined(): Promise<void>;
  toBeDefined(): Promise<void>;
  toBeNull(): Promise<void>;
  toBeTruthy(): Promise<void>;
  toBeFalsy(): Promise<void>;
  toBeNumber(): Promise<void>;
  toBeInstanceOf(expected: unknown): Promise<void>;
  toBeGreaterThan(expected: number | string | bigint): Promise<void>;
  toBeGreaterThanOrEqual(expected: number | string | bigint): Promise<void>;
  toBeLessThan(expected: number | string | bigint): Promise<void>;
  toBeLessThanOrEqual(expected: number | string | bigint): Promise<void>;
  toBeCloseTo(expected: number, digits?: number): Promise<void>;
  toStartWith(expected: string): Promise<void>;
  toHaveLength(expected: number): Promise<void>;
  toHaveProperty(path: string, ...value: unknown[]): Promise<void>;
  toThrow(expected?: unknown): Promise<void>;
}

function label(message: string | undefined, failure: string): string {
  return message ? `${message}\n${failure}` : failure;
}

function run(name: string, check: Check, actual: unknown, args: unknown[], negate: boolean, message?: string): void {
  const failure = check(actual, args);
  if (!negate) {
    if (failure) throw new AssertionError(label(message, failure));
    return;
  }
  if (!failure) throw new AssertionError(label(message, `expected the opposite of: ${name} ${show(actual)}`));
}

function matchers(actual: unknown, negate: boolean, message?: string): Matchers {
  const built: Record<string, (...args: unknown[]) => void> = {};
  for (const [name, check] of Object.entries(MATCHERS)) {
    built[name] = (...args: unknown[]) => run(name, check, actual, args, negate, message);
  }
  return built as unknown as Matchers;
}

function asyncMatchers(
  promise: Promise<unknown>,
  mode: "resolves" | "rejects",
  negate: boolean,
  message?: string,
): AsyncMatchers {
  const built: Record<string, (...args: unknown[]) => Promise<void>> = {};
  for (const [name, check] of Object.entries(MATCHERS)) {
    built[name] = async (...args: unknown[]) => {
      let settled = false;
      let value: unknown;
      let error: unknown;
      try {
        value = await promise;
      } catch (caught) {
        settled = true;
        error = caught;
      }
      if (mode === "resolves") {
        if (settled) throw new AssertionError(`expected the promise to resolve, but it rejected with ${show(error)}`);
        run(name, check, value, args, negate, message);
        return;
      }
      if (!settled) throw new AssertionError(`expected the promise to reject, but it resolved with ${show(value)}`);
      // A rejection reason is the value under test; toThrow expects a thrower.
      const subject = name === "toThrow" ? () => { throw error; } : error;
      run(name, check, subject, args, negate, message);
    };
  }
  return built as unknown as AsyncMatchers;
}

export interface Expectation extends Matchers {
  readonly not: Matchers;
  readonly resolves: AsyncMatchers;
  readonly rejects: AsyncMatchers;
}

/**
 * `message` mirrors the runner the tests were written on: an optional second
 * argument to expect() that is prefixed to any failure of this assertion.
 */
function expectValue(actual: unknown, message?: string): Expectation {
  return {
    ...matchers(actual, false, message),
    not: matchers(actual, true, message),
    resolves: asyncMatchers(Promise.resolve(actual), "resolves", false, message),
    rejects: asyncMatchers(Promise.resolve(actual), "rejects", false, message),
  };
}

/** Callable assertion entry point with the asymmetric matchers attached. */
export const expect = Object.assign(expectValue, {
  any: (expected: unknown): AsymmetricMatcher => new AnyMatcher(expected),
  anything: (): AsymmetricMatcher => new AnythingMatcher(),
  stringContaining: (expected: string): AsymmetricMatcher => new StringContainingMatcher(expected),
  stringMatching: (expected: RegExp | string): AsymmetricMatcher => new StringMatchingMatcher(expected),
});
