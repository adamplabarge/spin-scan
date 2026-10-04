import { defineConfig } from 'tsup';

const shared = {
  format: ['esm', 'cjs'] as ('esm' | 'cjs')[],
  dts: true,
  sourcemap: true,
  target: 'es2020',
  treeshake: true,
  external: ['react', 'react/jsx-runtime'],
};

export default defineConfig([
  { ...shared, entry: { index: 'src/index.ts', testing: 'src/testing/index.ts' }, clean: true },
  // React entry is marked as a client module so it can be imported directly from Next.js App Router code.
  // It imports the core through the package name so both entries share one copy at runtime;
  // rollup tree-shaking is off here because it strips the "use client" directive.
  {
    ...shared,
    entry: { react: 'src/react/index.ts' },
    external: [...shared.external, 'spin-scan'],
    treeshake: false,
    banner: { js: '"use client";' },
  },
]);
