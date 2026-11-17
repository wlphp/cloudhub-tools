export const ghProxyWorkerTemplate = String.raw`/**
 * Cloudflare Workers module adaptation of hunshcn/gh-proxy.
 * Upstream: https://github.com/hunshcn/gh-proxy
 * Source: https://github.com/hunshcn/gh-proxy/blob/master/index.js
 * README: https://github.com/hunshcn/gh-proxy/blob/master/README.md
 * Copyright (c) 2020 hunshcn. Licensed under the MIT License.
 * License: https://github.com/hunshcn/gh-proxy/blob/master/LICENSE
 *
 * MIT License
 * Copyright (c) 2020 hunshcn
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const ASSET_URL = 'https://hunshcn.github.io/gh-proxy/';
// For a custom route such as example.com/gh/*, set this to '/gh/'.
const PREFIX = '/';
const Config = { jsdelivr: 0 };
const whiteList = [];
const PREFLIGHT_INIT = {
  status: 204,
  headers: new Headers({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
    'access-control-max-age': '1728000',
  }),
};

const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i;
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i;
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i;
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i;
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i;
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i;

function makeRes(body, status = 200, headers = {}) {
  headers['access-control-allow-origin'] = '*';
  return new Response(body, { status, headers });
}

function newUrl(urlStr) {
  try { return new URL(urlStr); } catch { return null; }
}

function checkUrl(url) {
  return [exp1, exp2, exp3, exp4, exp5, exp6].some(pattern => pattern.test(url));
}

async function fetchHandler(req) {
  const urlObj = new URL(req.url);
  let path = urlObj.searchParams.get('q');
  if (path) return Response.redirect('https://' + urlObj.host + PREFIX + path, 301);

  // Cloudflare Workers may collapse double slashes in the incoming path.
  path = urlObj.href.slice(urlObj.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://');
  if (exp1.test(path) || exp5.test(path) || exp6.test(path) || exp3.test(path)) {
    return httpHandler(req, path);
  }
  if (exp2.test(path)) {
    if (Config.jsdelivr) {
      const target = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh');
      return Response.redirect(target, 302);
    }
    return httpHandler(req, path.replace('/blob/', '/raw/'));
  }
  if (exp4.test(path)) {
    if (Config.jsdelivr) {
      const target = path.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh');
      return Response.redirect(target, 302);
    }
    return httpHandler(req, path);
  }
  return fetch(ASSET_URL + path);
}

function httpHandler(req, pathname) {
  const rawHeaders = req.headers;
  if (req.method === 'OPTIONS' && rawHeaders.has('access-control-request-headers')) {
    return new Response(null, PREFLIGHT_INIT);
  }

  const headers = new Headers(rawHeaders);
  let allowed = whiteList.length === 0;
  for (const item of whiteList) {
    if (pathname.includes(item)) { allowed = true; break; }
  }
  if (!allowed) return new Response('blocked', { status: 403 });
  const urlStr = /^https?:\/\//.test(pathname) ? pathname : 'https://' + pathname;
  const target = newUrl(urlStr);
  if (!target) return new Response('Invalid GitHub URL', { status: 400 });
  return proxy(target, { method: req.method, headers, redirect: 'manual', body: req.body });
}

async function proxy(urlObj, reqInit) {
  const res = await fetch(urlObj.href, reqInit);
  const headers = new Headers(res.headers);
  if (headers.has('location')) {
    const location = headers.get('location');
    if (checkUrl(location)) headers.set('location', PREFIX + location);
    else {
      reqInit.redirect = 'follow';
      const next = newUrl(location);
      if (!next) return makeRes('Invalid redirect URL', 502);
      return proxy(next, reqInit);
    }
  }
  headers.set('access-control-expose-headers', '*');
  headers.set('access-control-allow-origin', '*');
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  headers.delete('clear-site-data');
  return new Response(res.body, { status: res.status, headers });
}

export default { fetch: fetchHandler };
`;
