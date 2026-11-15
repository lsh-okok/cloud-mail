import { build } from 'esbuild';
import { packageNodeDeployment } from './package-node-deployment.mjs';

await build({
  entryPoints: { index: 'src/server/index.js', cli: 'src/server/cli.js' },
  outdir: 'server-dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

await packageNodeDeployment();
