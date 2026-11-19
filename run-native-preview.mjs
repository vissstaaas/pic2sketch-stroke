import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|js|mjs|json)$/.test(specifier)) {
      try { return nextResolve(specifier + '.ts', context); } catch {}
    }
    return nextResolve(specifier, context);
  }
});
await import('./tools/run-preview.mjs');