import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { handleAuthNavigation, launchAuthBrowser, shutdownAuthServer } from '../src/auth-ui.mjs';

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
  assert.equal(result.headers.connection, 'close');
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

test('normal shutdown waits for the callback response and queued output before preserving exit status', async () => {
  const response = new EventEmitter();
  const events = [];
  const server = { close(callback) { events.push('server closed'); callback(); } };
  const stdout = { write(_text, callback) { events.push('stdout drained'); callback(); } };
  const stderr = { write(_text, callback) { events.push('stderr drained'); callback(); } };
  let exitCode;
  shutdownAuthServer(server, { response, exitCode: 1, stdout, stderr, exit: code => { events.push('exit'); exitCode = code; } });
  assert.deepEqual(events, []);
  response.emit('finish');
  assert.deepEqual(events, ['server closed', 'stdout drained', 'stderr drained', 'exit']);
  assert.equal(exitCode, 1);
});

test('a real child exits after response flush even with another HTTP connection held open', async t => {
  const moduleUrl = new URL('../src/auth-ui.mjs', import.meta.url).href;
  const script = `
    import { createServer, get } from 'node:http';
    import { connect } from 'node:net';
    import { shutdownAuthServer } from ${JSON.stringify(moduleUrl)};
    let held;
    const server = createServer((req, res) => {
      if (req.url === '/held') {
        get({ host: '127.0.0.1', port: server.address().port, path: '/complete' }, response => {
          let body = ''; response.on('data', chunk => { body += chunk; });
          response.on('end', () => console.log('browser received: ' + body));
        });
        return;
      }
      res.setHeader('Connection', 'close');
      res.once('finish', () => console.log('response flushed'));
      res.end('complete');
      console.log('completion output retained');
      process.exitCode = 7;
      shutdownAuthServer(server, { response: res, deadlineMs: 150 });
    });
    server.listen(0, '127.0.0.1', () => {
      held = connect(server.address().port, '127.0.0.1', () => held.write('GET /held HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n\\r\\n'));
      held.on('error', () => {});
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const limit = setTimeout(() => child.kill(), 2500);
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(limit);
  assert.equal(result.signal, null, errors); assert.equal(result.code, 7, errors);
  assert.match(output, /completion output retained/); assert.match(output, /response flushed/); assert.match(output, /browser received: complete/);
});
