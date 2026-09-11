// Minimal vitest-compatible shim so the real test files can run on plain Node
// (the sandbox blocks esbuild's piped child process, which vite/vitest need).
const tests = [];
let currentSuite = '';

export function describe(name, fn) {
  const previous = currentSuite;
  currentSuite = previous ? previous + ' > ' + name : name;
  fn();
  currentSuite = previous;
}

export function it(name, fn) {
  tests.push({ name: (currentSuite ? currentSuite + ' > ' : '') + name, fn });
}

export const test = it;

export function beforeEach() {}
export function afterEach() {}
export function beforeAll() {}
export function afterAll() {}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function format(value) {
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

const MATCHERS = {
  toBe: (a, e) => Object.is(a, e),
  toEqual: (a, e) => deepEqual(a, e),
  toStrictEqual: (a, e) => deepEqual(a, e),
  toBeDefined: (a) => a !== undefined,
  toBeUndefined: (a) => a === undefined,
  toBeNull: (a) => a === null,
  toBeTruthy: (a) => !!a,
  toBeFalsy: (a) => !a,
  toBeNaN: (a) => Number.isNaN(a),
  toBeGreaterThan: (a, e) => a > e,
  toBeGreaterThanOrEqual: (a, e) => a >= e,
  toBeLessThan: (a, e) => a < e,
  toBeLessThanOrEqual: (a, e) => a <= e,
  toBeCloseTo: (a, e, digits = 2) => Math.abs(a - e) < Math.pow(10, -digits) / 2,
  toHaveLength: (a, e) => a != null && a.length === e,
  toContain: (a, e) => a != null && typeof a.includes === 'function' && a.includes(e),
  toMatch: (a, e) => new RegExp(e).test(a),
  toHaveBeenCalled: (a) => (a?.mock?.calls?.length ?? 0) > 0,
  toHaveBeenCalledWith: (a, ...e) => (a?.mock?.calls ?? []).some((call) => deepEqual(call, e)),
  toHaveBeenCalledTimes: (a, e) => (a?.mock?.calls?.length ?? 0) === e,
  toThrow: (a, e) => {
    try { a(); } catch (err) { return e ? new RegExp(e).test(String(err)) : true; }
    return false;
  },
};

function build(actual, negated) {
  const target = {};
  for (const [name, impl] of Object.entries(MATCHERS)) {
    target[name] = (...args) => {
      let pass = impl(actual, ...args);
      if (negated) pass = !pass;
      if (!pass) {
        const detail = args.length ? ' expected ' + format(args[0]) : '';
        throw new Error('expected ' + format(actual) + (negated ? ' not' : '') + ' ' + name + detail);
      }
    };
  }
  return target;
}

export function expect(actual) {
  const api = build(actual, false);
  api.not = build(actual, true);
  api.resolves = api;
  api.rejects = api;
  return api;
}

export const vi = {
  fn(impl) {
    const mock = function (...args) {
      mock.mock.calls.push(args);
      if (impl) return impl(...args);
      return undefined;
    };
    mock.mock = { calls: [], results: [] };
    mock.mockReturnValue = (value) => { impl = () => value; return mock; };
    mock.mockImplementation = (fn) => { impl = fn; return mock; };
    mock.mockClear = () => { mock.mock.calls.length = 0; return mock; };
    mock.mockReset = () => { mock.mock.calls.length = 0; return mock; };
    return mock;
  },
  clearAllMocks() {},
  resetAllMocks() {},
};

export async function runAll() {
  let passed = 0;
  const failures = [];
  for (const item of tests) {
    try {
      await item.fn();
      passed++;
    } catch (err) {
      failures.push({ name: item.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { passed, failed: failures.length, total: tests.length, failures };
}
