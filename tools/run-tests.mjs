import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const shimUrl = pathToFileURL(resolve(process.cwd(), 'tools/vitest-shim.mjs')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vitest') return { url: shimUrl, shortCircuit: true };
    if (specifier.startsWith('.') && !/\.(ts|js|mjs|json)$/.test(specifier)) {
      try { return nextResolve(specifier + '.ts', context); } catch { /* fall through */ }
    }
    return nextResolve(specifier, context);
  },
});

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const shim = await import(shimUrl);
const files = process.argv.slice(2);
if (files.length === 0) files.push('src/__tests__/sketch.test.ts', 'src/__tests__/canvas-engine.test.ts');
for (const file of files) await import(pathToFileURL(resolve(process.cwd(), file)).href);

const result = await shim.runAll();
for (const failure of result.failures) console.log('FAIL  ' + failure.name + '\n      ' + failure.error);
console.log('\ntests: ' + result.passed + ' passed, ' + result.failed + ' failed, ' + result.total + ' total');
process.exit(result.failed > 0 ? 1 : 0);
