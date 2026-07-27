/**
 * Cloudflare Pages Function: same-origin proxy for Tesla's dashcam key API.
 *
 * The app is a static export (`output: "export"`), and a browser cannot call
 * dashcam.tesla.com directly — Tesla serves no CORS headers and its CSP is
 * `connect-src 'self' https://auth.tesla.com`. So the key request is made
 * server-to-server from here, with Tesla's own Origin/Referer, mirroring the
 * official web viewer.
 *
 * Only file identifiers and ownership metadata pass through — never video.
 * The caller's Tesla bearer token is forwarded verbatim and is deliberately
 * never logged, echoed into an error body, or persisted.
 *
 * Local dev uses the Next dev-server rewrite instead (see next.config.ts);
 * the Docker image uses nginx (see nginx.conf). All three expose the same
 * /tesla-decrypt/ path so the client URL is identical everywhere.
 */

const UPSTREAM_ORIGIN = 'https://dashcam.tesla.com';

/** Only the decryption endpoints may be reached — this is not an open proxy. */
const ALLOWED_PATH_PREFIX = 'api/1/decrypt/';

interface PagesContext {
  request: Request;
  params: { path?: string | string[] };
}

export async function onRequest({ request, params }: PagesContext): Promise<Response> {
  const segments = params.path === undefined ? [] : ([] as string[]).concat(params.path);
  const path = segments.join('/');

  if (!path.startsWith(ALLOWED_PATH_PREFIX)) {
    return json({ error: 'Not found' }, 404);
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, { allow: 'POST' });
  }

  const authorization = request.headers.get('authorization');
  if (!authorization) {
    return json({ error: 'Missing Authorization header' }, 401);
  }

  // Buffered rather than streamed: these payloads are a few hundred bytes of
  // key metadata, and a buffered body keeps the upstream request a plain
  // non-duplex fetch.
  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM_ORIGIN}/${path}`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        accept: 'application/json',
        origin: UPSTREAM_ORIGIN,
        referer: `${UPSTREAM_ORIGIN}/`,
      },
      body,
    });
  } catch {
    // Intentionally opaque: the request carried a bearer token, so nothing
    // from it is reflected back.
    return json({ error: 'Upstream request to Tesla failed' }, 502);
  }

  // Rebuild the response rather than forwarding it, so no upstream Set-Cookie
  // or auth-related header reaches the browser.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function json(payload: unknown, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });
}
