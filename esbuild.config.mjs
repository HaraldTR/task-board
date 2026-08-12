import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2020',
  logLevel: 'info',
  sourcemap: false,
  treeShaking: true,
  outfile: 'main.js',
  define: { 'process.env.NODE_ENV': '"production"' },
});
