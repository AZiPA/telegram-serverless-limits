import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../experiments/runtime.js', import.meta.url), 'utf8');

async function probe(db = {}) {
  const context = vm.createContext({});
  const sdk = new vm.SyntheticModule(['db'], function () { this.setExport('db', db); }, { context });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((name) => {
    assert.equal(name, 'sdk');
    return sdk;
  });
  await module.evaluate();
  return module.namespace.default;
}

test('CPU workload retains its checksum in a sandbox without Node globals', async () => {
  const run = await probe();
  const result = await run({ kind: 'cpu', iterations: 1_000_000 });
  assert.equal(result.checksum, 868636661);
  assert.equal(result.iterations, 1_000_000);
});

test('buffer and heap probes fill and verify all requested blocks', async () => {
  const run = await probe();
  const buffer = await run({ kind: 'buffer', mib: 2 });
  const heap = await run({ kind: 'heap', mib: 2 });
  assert.equal(buffer.elements, 2 * 1024 * 1024);
  assert.equal(buffer.checksum, 6);
  assert.equal(heap.elements, 2 * 1024 * 1024 / 8);
  assert.equal(heap.checksum, 4);
});

test('byte-granular buffer checks cover a partial last block and distinguish reservation from filling', async () => {
  const run = await probe();
  const filled = await run({ kind: 'binary', bytes: 8193, chunkBytes: 4096, touch: 'fill' });
  assert.equal(filled.totalBytes, 8193);
  assert.equal(filled.count, 3);
  assert.equal(filled.verifiedPages, 3);
  assert.equal(filled.checksum, 12);
  const reserved = await run({ kind: 'binary', bytes: 8193, touch: 'edges' });
  assert.equal(reserved.count, 1);
  assert.equal(reserved.verifiedPages, 0);
  assert.equal(reserved.checksum, 2);
  await assert.rejects(() => run({ kind: 'binary', bytes: 0, touch: 'fill' }));
  await assert.rejects(() => run({ kind: 'binary', bytes: 8 * 1024 ** 3 + 1, touch: 'fill' }));
  await assert.rejects(() => run({ kind: 'binary', bytes: 8193, touch: 'edges', fullView: 'yes' }));
  const viewed = await run({ kind: 'binary', bytes: 8193, touch: 'edges', fullView: true });
  assert.equal(viewed.fullView, true);
});

test('buffer settling keeps a bounded CPU workload and a verifiable result', async () => {
  const run = await probe();
  const result = await run({ kind: 'binary', bytes: 1, touch: 'edges', settle: true });
  assert.equal(result.settleChecksum, 1293436906);
  assert.equal(result.totalBytes, 1);
  assert.equal(result.verifiedPages, 0);
});

test('minimal buffer runtime needs no SDK and verifies an incomplete final page', async () => {
  const minimalSource = await readFile(new URL('../experiments/buffer-isolated.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(minimalSource, { context: vm.createContext({}) });
  await module.link(() => { throw new Error('Minimal runtime must not import an SDK'); });
  await module.evaluate();
  const result = module.namespace.default({ bytes: 4097, touch: 'fill' });
  assert.equal(result.totalBytes, 4097);
  assert.equal(result.verifiedPages, 2);
  assert.equal(result.checksum, 1293436906);
  assert.throws(() => module.namespace.default({ bytes: 0, touch: 'fill' }));
  assert.throws(() => module.namespace.default({ bytes: 8 * 1024 ** 3 + 1, touch: 'fill' }));
});

test('unbounded workloads and unsafe table names are rejected before any SQL', async () => {
  let sqlCalls = 0;
  const run = await probe({ run() { sqlCalls++; } });
  for (const input of [
    null,
    { kind: 'cpu', iterations: -1 },
    { kind: 'cpu', iterations: 30_000_000_001 },
    { kind: 'buffer', mib: 1025 },
    { kind: 'heap', mib: 1.5 },
    { kind: 'storage', action: 'drop', table: 'users' },
    { kind: 'storage', action: 'drop', table: '__tg_probe_123456789abc;DROP TABLE users' },
    { kind: 'storage', action: 'fill', table: '__tg_probe_123456789abc', mib: 9 },
    { kind: 'storage', action: 'fill', table: '__tg_probe_123456789abc', blocks: 129 },
    { kind: 'sql', query: 'toString' },
  ]) await assert.rejects(() => run(input));
  assert.equal(sqlCalls, 0);
});

test('storage writes and cleanup address only the named probe table', async () => {
  const statements = [];
  const run = await probe({
    async run(sql, bindings) { statements.push({ sql, bindings }); },
    async get(sql) {
      assert.ok(sql.includes('"__tg_probe_123456789abc"'));
      return { rows: 16, payloadBytes: 1048576 };
    },
  });
  const input = { kind: 'storage', table: '__tg_probe_123456789abc' };
  await run({ ...input, action: 'create' });
  const result = await run({ ...input, action: 'fill', mib: 1 });
  await run({ ...input, action: 'drop' });
  assert.equal(result.payloadBytes, 1048576);
  assert.equal(statements[1].bindings[':chunks'], 16);
  assert.match(statements[0].sql, /^CREATE TABLE "__tg_probe_123456789abc" /);
  assert.equal(statements[2].sql, 'DROP TABLE IF EXISTS "__tg_probe_123456789abc"');
});

test('compaction refuses a database containing user tables', async () => {
  let writes = 0;
  const run = await probe({
    async all() { return [{ name: 'users' }]; },
    async run() { writes++; },
  });
  await assert.rejects(() => run({ kind: 'compact-empty-db' }), /empty database/);
  assert.equal(writes, 0);
});

test('the write/read health check drops its own table if reading fails', async () => {
  const statements = [];
  const run = await probe({
    async run(sql) { statements.push(sql); },
    async get() { throw new Error('Read failed'); },
  });
  await assert.rejects(() => run({ kind: 'storage', action: 'check', table: '__tg_probe_123456789abc' }), /Read failed/);
  assert.equal(statements.length, 3);
  assert.equal(statements[2], 'DROP TABLE "__tg_probe_123456789abc"');
});
