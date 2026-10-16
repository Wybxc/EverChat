// Node-only signer. No private key is sent to a Worker, browser, or production bundle.
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Plugin } from 'vite';
import { authReturnTo } from '../../shared/auth/navigation';

export async function localAccess() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: 'local-access',
    alg: 'RS256',
    use: 'sig',
  };
  const portFlag = process.argv.indexOf('--port');
  const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 5173;
  const origin = `http://127.0.0.1:${port}`;
  const plugin: Plugin = {
    name: 'everchat-local-access',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', origin);
        if (!url.pathname.startsWith('/__dev/access/')) return next();
        if (
          req.headers.host !== new URL(origin).host ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
          (req.headers.origin && req.headers.origin !== origin)
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/__dev/access/login' && ['GET', 'POST'].includes(req.method ?? '')) {
          const token = await new SignJWT({ email: 'developer@everchat.local', type: 'app' })
            .setProtectedHeader({ alg: 'RS256', kid: 'local-access' })
            .setIssuer('http://everchat.local.invalid')
            .setAudience('everchat-local')
            .setSubject('local-developer')
            .setIssuedAt()
            .setExpirationTime('12h')
            .sign(privateKey);
          res.setHeader(
            'Set-Cookie',
            `everchat_dev_access=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
          );
          if (req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          } else {
            res.writeHead(303, {
              Location: authReturnTo(url.searchParams.get('returnTo'), origin),
            });
            res.end();
          }
          return;
        }
        if (url.pathname === '/__dev/access/logout') {
          res.writeHead(200, {
            'Set-Cookie': 'everchat_dev_access=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
            'Content-Type': 'text/html; charset=utf-8',
          });
          res.end('<a href="/">返回 EverChat</a>');
          return;
        }
        res.writeHead(404);
        res.end();
      });
    },
  };
  return {
    plugin,
    vars: { DEV_ACCESS_ORIGIN: origin, DEV_ACCESS_PUBLIC_JWK: JSON.stringify(publicJwk) },
  };
}
