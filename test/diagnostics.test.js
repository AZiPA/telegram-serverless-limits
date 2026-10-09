import assert from 'node:assert/strict';
import test from 'node:test';
import { collectDiagnostics } from '../tgcloud/lib/diagnostics.js';

function database(overrides = {}) {
  const rows = {
    'PRAGMA page_size': { page_size: 4096 },
    'PRAGMA page_count': { page_count: 20 },
    'PRAGMA freelist_count': { freelist_count: 3 },
    ...overrides,
  };
  return {
    async get(statement) {
      assert.ok(Object.hasOwn(rows, statement), `Unexpected SQL: ${statement}`);
      return rows[statement];
    },
  };
}

test('reports a real allocation and SQLite usage without inventing host limits', async () => {
  const report = await collectDiagnostics(database());
  assert.equal(report.cpu.logicalCores, null);
  assert.equal(report.cpu.quotaCores, null);
  assert.equal(report.cpu.probe.iterations, 1_000_000);
  assert.equal(report.cpu.probe.checksum, 868636661);
  assert.equal(report.memory.limitBytes, null);
  assert.equal(report.memory.availableBytes, null);
  assert.equal(report.memory.probe.status, 'ok');
  assert.equal(report.memory.probe.verifiedBytes, 4 * 1024 * 1024);
  assert.equal(report.disk.filesystemAvailable, false);
  assert.equal(report.disk.totalBytes, null);
  assert.equal(report.disk.freeBytes, null);
  assert.equal(report.disk.database.allocatedBytes, 81920);
  assert.equal(report.disk.database.reusableBytes, 12288);
  assert.equal(report.disk.database.quotaBytes, null);
  assert.deepEqual(report.disk.database.errors, []);
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('a rejected PRAGMA does not hide CPU, memory or successful SQLite reads', async () => {
  const db = database();
  const get = db.get;
  db.get = async (statement) => {
    if (statement === 'PRAGMA page_count') throw new Error('PRAGMA denied');
    return get(statement);
  };
  const report = await collectDiagnostics(db);
  assert.equal(report.memory.probe.status, 'ok');
  assert.equal(report.cpu.probe.checksum, 868636661);
  assert.equal(report.disk.database.pageSizeBytes, 4096);
  assert.equal(report.disk.database.allocatedBytes, null);
  assert.equal(report.disk.database.reusableBytes, 12288);
  assert.deepEqual(report.disk.database.errors, [
    { pragma: 'page_count', message: 'PRAGMA denied' },
  ]);
});

test('absent or malformed PRAGMA values remain unknown instead of becoming zero', async () => {
  const report = await collectDiagnostics(database({
    'PRAGMA page_size': undefined,
    'PRAGMA page_count': { page_count: '20' },
    'PRAGMA freelist_count': { freelist_count: -1 },
  }));
  assert.equal(report.disk.database.pageSizeBytes, null);
  assert.equal(report.disk.database.pageCount, null);
  assert.equal(report.disk.database.freePageCount, null);
  assert.equal(report.disk.database.allocatedBytes, null);
  assert.equal(report.disk.database.reusableBytes, null);
  assert.equal(report.disk.database.errors.length, 3);
});

test('an empty database is zero bytes, not an unavailable result', async () => {
  const report = await collectDiagnostics(database({
    'PRAGMA page_count': { page_count: 0 },
    'PRAGMA freelist_count': { freelist_count: 0 },
  }));
  assert.equal(report.disk.database.allocatedBytes, 0);
  assert.equal(report.disk.database.reusableBytes, 0);
  assert.deepEqual(report.disk.database.errors, []);
});

test('unsafe byte totals are not reported as exact sizes', async () => {
  const report = await collectDiagnostics(database({
    'PRAGMA page_count': { page_count: Number.MAX_SAFE_INTEGER },
  }));
  assert.equal(report.disk.database.allocatedBytes, null);
});

test('the CPU probe terminates with a frozen clock and without performance', async () => {
  const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const originalNow = Date.now;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: undefined });
  Date.now = () => 1000;
  try {
    const report = await collectDiagnostics(database());
    assert.equal(report.cpu.probe.clock, 'Date.now');
    assert.equal(report.cpu.probe.elapsedMs, 0);
    assert.equal(report.cpu.probe.iterationsPerSecond, null);
    assert.equal(report.cpu.probe.checksum, 868636661);
  } finally {
    Object.defineProperty(globalThis, 'performance', previousPerformance);
    Date.now = originalNow;
  }
});

test('a catchable allocation failure still returns CPU and database information', async () => {
  const OriginalUint8Array = globalThis.Uint8Array;
  globalThis.Uint8Array = class {
    constructor() { throw new RangeError('Allocation refused'); }
  };
  try {
    const report = await collectDiagnostics(database());
    assert.equal(report.memory.probe.status, 'unavailable');
    assert.equal(report.memory.probe.verifiedBytes, null);
    assert.equal(report.memory.probe.error, 'Allocation refused');
    assert.equal(report.disk.database.allocatedBytes, 81920);
  } finally {
    globalThis.Uint8Array = OriginalUint8Array;
  }
});
