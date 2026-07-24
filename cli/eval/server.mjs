// Loopback static server for the simulated eval pages (cli/eval/pages/).
// Library: startPagesServer() — used by run.mjs, captures form submissions.
// Standalone: node eval/server.mjs [--port 8907] to browse the pages manually.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export async function startPagesServer({ port = 0 } = {}) {
  const root = join(dirname(fileURLToPath(import.meta.url)), 'pages');
  // submissions: final form submits (the form task requires this stays EMPTY).
  // progress: step beacons proving the form was actually walked, not
  // source-read (the form task requires a step-3 beacon).
  const state = { submissions: [], progress: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (
      req.method === 'POST' &&
      (url.pathname === '/api/form-submit' || url.pathname === '/api/form-progress')
    ) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const bucket = url.pathname.endsWith('submit') ? state.submissions : state.progress;
        bucket.push({ body, at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"message":"Request received"}');
      });
      return;
    }

    let pathname = normalize(decodeURIComponent(url.pathname));
    if (pathname.endsWith('/')) {
      pathname += 'index.html';
    }
    const file = join(root, pathname);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    readFile(file).then(
      (data) => {
        res.writeHead(200, {
          'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        });
        res.end(data);
      },
      () => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const boundPort = server.address().port;
  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : 8907;
  const { url } = await startPagesServer({ port });
  console.log(`eval pages served at ${url}/`);
}
