import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('node_modules/.cache', { recursive: true });

await build({
  entryPoints: ['scripts/store-check.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'node_modules/.cache/store-check.mjs',
  plugins: [{
    name: 'test-alias',
    setup(plugin) {
      plugin.onResolve({ filter: /^~\/composables\/useLocalPersist$/ }, () => ({ path: new URL('./fake-persist.mjs', import.meta.url).pathname }));
      plugin.onResolve({ filter: /^~\/utils\/(.+)$/ }, (args) => ({ path: `${process.cwd()}/utils/${args.path.slice('~/utils/'.length)}.ts` }));
      plugin.onResolve({ filter: /^~\/types\/(.+)$/ }, (args) => ({ path: `${process.cwd()}/types/${args.path.slice('~/types/'.length)}.ts` }));
    }
  }]
});
