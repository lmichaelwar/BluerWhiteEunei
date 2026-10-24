import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleAuthNavigation, launchAuthBrowser } from '../src/auth-ui.mjs';

const options = { port: 1455, authorizationUrl: 'https://auth.openai.com/example?state=mock-state' };
function navigate(path, { host = '127.0.0.1:1455', method = 'GET' } = {}) {
  const response = {
    headers: {}, body: '', status: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers) { this.status = status; for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value); },
    end(body = '') { this.body = body; },
  };
  const handled = handleAuthNavigation({ url: path, headers: { host }, method }, response, options);
  return { handled, ...response };
}

test('local landing page gives a visible sign-in link without embedding the OAuth URL', () => {
  const result = navigate('/');
  assert.equal(result.handled, true); assert.equal(result.status, 200);
  assert.match(result.body, /Continue with ChatGPT/); assert.match(result.body, /href="\/auth\/start"/);
  assert.doesNotMatch(result.body, /mock-state|auth\.openai\.com/);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
});

test('local start redirects to the pending attempt and validated callback remains unchanged', () => {
  const start = navigate('/auth/start');
  assert.equal(start.status, 302); assert.equal(start.headers.location, options.authorizationUrl);
  assert.equal(start.headers['cache-control'], 'no-store'); assert.equal(start.headers['referrer-policy'], 'no-referrer');
  assert.equal(navigate('/auth/callback?state=mock&code=mock').handled, false);
});

test('all local helper routes reject other hosts, absolute targets and non-GET methods', () => {
  for (const path of ['/', '/auth/start', '/auth/callback']) {
    for (const host of ['localhost:1455', 'evil.example:1455', '127.0.0.1:9999', '127.0.0.1:1455.evil.example']) assert.equal(navigate(path, { host }).status, 403);
    const rejected = navigate(path, { method: 'POST' }); assert.equal(rejected.status, 405); assert.equal(rejected.headers.allow, 'GET');
  }
  assert.equal(navigate('https://evil.example/auth/start').status, 403);
});

test('browser launcher opens only the local page and reports silent nonzero exits once', () => {
  const child = new EventEmitter(); child.unref = () => {};
  const reports = []; let invoked;
  launchAuthBrowser('http://127.0.0.1:1455/', { platform: 'linux', report: text => reports.push(text), spawnImpl: (command, args) => { invoked = { command, args }; return child; } });
  assert.deepEqual(invoked, { command: 'xdg-open', args: ['http://127.0.0.1:1455/'] });
  child.emit('close', 3, null); child.emit('error', new Error('private launcher detail'));
  assert.equal(reports.length, 1); assert.match(reports[0], /did not complete successfully/); assert.match(reports[0], /127\.0\.0\.1:1455/);
  assert.doesNotMatch(reports[0], /private launcher detail/);
});

test('browser launcher reports a spawn failure without exposing its raw error', () => {
  const child = new EventEmitter(); child.unref = () => {};
  const reports = [];
  launchAuthBrowser('http://127.0.0.1:1455/', { report: text => reports.push(text), spawnImpl: () => child });
  child.emit('error', new Error('sensitive detail'));
  assert.equal(reports.length, 1); assert.match(reports[0], /could not start/); assert.doesNotMatch(reports[0], /sensitive detail/);
});
