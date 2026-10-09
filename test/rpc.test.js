import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

test('RPC respects retry_after, retains timing and never records a token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tg-probe-test-'));
  const fakeToken = 'app1:test_secret';
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(Date.now());
    assert.equal(request.url, '/app1/manage/run');
    assert.equal(request.headers.authorization, `Bearer ${fakeToken}`);
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Connection', 'close');
    if (calls.length === 1) {
      response.writeHead(429);
      response.end(JSON.stringify({ ok: false, error_type: 'RATE_LIMITED', parameters: { retry_after: 0 } }));
    } else {
      response.end(JSON.stringify({ ok: true, result: { time: 0.02, result: { echoed: fakeToken } } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const moduleUrl = new URL('../experiments/rpc.mjs', import.meta.url).href;
    const script = `import { requestProbe } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(await requestProbe({ kind: 'metadata' })));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: directory,
      env: { ...process.env, TGCLOUD_TOKEN: fakeToken, TGCLOUD_BETA: '0',
        TG_CLOUD_API_URL: `http://127.0.0.1:${server.address().port}` },
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[1] - calls[0] >= 900);
    const recordsText = await readFile(join(directory, 'reports/probes.jsonl'), 'utf8');
    assert.equal(recordsText.includes(fakeToken), false);
    assert.equal(stdout.includes(fakeToken), false);
    const records = recordsText.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records[0].httpStatus, 429);
    assert.equal(records[1].serverMs, 20);
    assert.equal(records[1].value.echoed, '[REDACTED]');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
