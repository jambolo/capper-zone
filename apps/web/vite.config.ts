import { readdir, readFile } from 'node:fs/promises';
import { extname, join, posix, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const projectRoot = resolve(import.meta.dirname, '../..');

/** The league configuration and the Rust programs' output live at the project root so the
 * CLIs, the backtest and the site all read one copy. This publishes them as static assets.
 */
function projectData(): Plugin {
  const mounts: Record<string, string> = {
    '/config': join(projectRoot, 'config'),
    '/data': join(projectRoot, 'data'),
  };
  const types: Record<string, string> = { '.json': 'application/json; charset=utf-8' };
  async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(path);
      else if (extname(path) === '.json') yield path;
    }
  }
  return {
    name: 'project-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        const mount = Object.keys(mounts).find((m) => path.startsWith(`${m}/`));
        if (!mount) return next();
        const root = mounts[mount]!;
        const file = resolve(root, path.slice(mount.length + 1));
        // Confine reads to the mounted directory.
        if (relative(root, file).startsWith('..')) return next();
        readFile(file).then(
          (bytes) => {
            res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store');
            res.end(bytes);
          },
          () => next(),
        );
      });
    },
    async generateBundle() {
      for (const [mount, root] of Object.entries(mounts)) {
        try {
          for await (const file of walk(root))
            this.emitFile({
              type: 'asset',
              fileName: posix.join(mount.slice(1), relative(root, file).split(/[\\/]/).join('/')),
              source: await readFile(file),
            });
        } catch {
          this.warn(`No ${mount} directory to publish; run the Rust programs before building.`);
        }
      }
    },
  };
}

// Project Pages sites are served from a subdirectory, so asset URLs must be relative to it.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/capper-zone/',
  plugins: [react(), projectData()],
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
