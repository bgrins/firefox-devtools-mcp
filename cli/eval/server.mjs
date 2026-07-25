// Loopback static server for the simulated eval pages (cli/eval/pages/).
// Library: startPagesServer() — used by run.mjs; issues per-session cookies
// and nonces so task validators can rely on SERVER-OBSERVED interaction
// (curl-forged beacons fail the nonce check; fixture files on disk hold no
// usable secrets). Standalone: node eval/server.mjs [--port 8907].
//
// Session model (prerequisite P-1 in task-ideas.md):
// - Any .html response without a valid `evalsid` cookie gets one
//   (HttpOnly, SameSite=Lax) plus a per-session nonce.
// - HTML bodies have the literal __SESSION_NONCE__ substituted so page JS
//   can authenticate beacons/fetches.
// - POST /api/beacon {nonce, kind, data} → state.beacons (403 on bad nonce).
// - Gated JSON APIs require the session cookie and X-Eval-Nonce header.

import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
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

const BODY_CAP = 65536;

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > BODY_CAP) {
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export async function startPagesServer({ port = 0 } = {}) {
  const root = join(dirname(fileURLToPath(import.meta.url)), 'pages');

  const state = {
    // sid -> { nonce, createdAt, ...per-task fields (e.g. reportAttempts) }
    sessions: new Map(),
    // { sid, kind, data, at }
    beacons: [],
    beaconsOf(kind) {
      return state.beacons.filter((b) => b.kind === kind);
    },
    reset() {
      state.sessions.clear();
      state.beacons.length = 0;
    },
  };

  function parseCookies(req) {
    const cookies = {};
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
      }
    }
    return cookies;
  }

  function getSession(req) {
    const sid = parseCookies(req).evalsid;
    const session = sid ? state.sessions.get(sid) : null;
    return session ? { sid, session } : null;
  }

  // Gated APIs: valid session cookie + matching nonce (header or body field).
  function requireSession(req, res, nonce) {
    const found = getSession(req);
    if (!found || (nonce ?? req.headers['x-eval-nonce']) !== found.session.nonce) {
      json(res, 403, { error: 'session required' });
      return null;
    }
    return found;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname0 = url.pathname;

    if (req.method === 'POST' && pathname0 === '/api/beacon') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      state.beacons.push({
        sid: found.sid,
        kind: String(payload.kind ?? ''),
        data: payload.data ?? null,
        at: Date.now(),
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname0 === '/api/flaky/report') {
      const found = requireSession(req, res);
      if (!found) return;
      const attempts = (found.session.reportAttempts =
        (found.session.reportAttempts ?? 0) + 1);
      if (attempts <= 2) {
        return json(res, 500, { error: 'Report backend unavailable. Try again.' });
      }
      return json(res, 200, { revenue: '$1,284,550', quarter: 'Q3' });
    }

    if (req.method === 'POST' && pathname0 === '/api/shadow/unlock') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const code = String(payload.code ?? '');
      state.beacons.push({
        sid: found.sid,
        kind: 'shadow-unlock',
        data: { code },
        at: Date.now(),
      });
      // The success message is server-issued so it never appears in fixture
      // source on disk.
      return json(
        res,
        200,
        code === 'ORCHID-22'
          ? { granted: true, message: 'Access granted: Metronome stage two is clear' }
          : { granted: false, message: 'Access denied: invalid code' }
      );
    }

    if (req.method === 'POST' && pathname0 === '/api/roster-submit') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
      state.beacons.push({
        sid: found.sid,
        kind: 'roster-submit',
        data: { attendees },
        at: Date.now(),
      });
      return json(res, 200, {
        groupCode: 'GRP-' + found.session.nonce.slice(0, 4).toUpperCase(),
      });
    }

    let pathname;
    try {
      pathname = normalize(decodeURIComponent(pathname0));
    } catch {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (pathname.endsWith('/')) {
      pathname += 'index.html';
    }
    const file = join(root, pathname);
    if (file !== root && !file.startsWith(root + '/')) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      let data = await readFile(file);
      const headers = {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      };
      if (extname(file) === '.html') {
        let found = getSession(req);
        if (!found) {
          const sid = randomUUID();
          const session = { nonce: randomBytes(12).toString('hex'), createdAt: Date.now() };
          state.sessions.set(sid, session);
          found = { sid, session };
          headers['Set-Cookie'] = `evalsid=${sid}; Path=/; HttpOnly; SameSite=Lax`;
        }
        const text = data.toString('utf8');
        if (text.includes('__SESSION_NONCE__')) {
          data = Buffer.from(text.replaceAll('__SESSION_NONCE__', found.session.nonce));
        }
      }
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
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
