const CPU_ITERATIONS = 1_000_000;
const MEMORY_BYTES = 4 * 1024 * 1024;

export async function collectDiagnostics(db) {
  const hasPerformanceClock = typeof globalThis.performance?.now === 'function';
  const now = hasPerformanceClock ? () => performance.now() : () => Date.now();

  let checksum = 0x12345678;
  const started = now();
  // A fixed bound also terminates when the sandbox clock does not advance.
  for (let i = 0; i < CPU_ITERATIONS; i++) {
    checksum ^= checksum << 13;
    checksum ^= checksum >>> 17;
    checksum ^= checksum << 5;
  }
  const elapsed = now() - started;
  const elapsedMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;

  const memoryProbe = { requestedBytes: MEMORY_BYTES, verifiedBytes: null, status: 'unavailable' };
  try {
    const bytes = new Uint8Array(MEMORY_BYTES);
    bytes.fill(0xa5);
    if (bytes[0] !== 0xa5 || bytes[bytes.length - 1] !== 0xa5) {
      throw new Error('Memory write verification failed.');
    }
    memoryProbe.verifiedBytes = bytes.length;
    memoryProbe.status = 'ok';
  } catch (error) {
    memoryProbe.error = String(error?.message ?? error);
  }

  const database = {
    pageSizeBytes: null,
    pageCount: null,
    freePageCount: null,
    allocatedBytes: null,
    reusableBytes: null,
    quotaBytes: null,
    errors: [],
    note: 'SQLite page storage, excluding WAL and other files. Reusable database pages are not free disk space. The storage quota is unknown.',
  };

  for (const [pragma, key] of [
    ['page_size', 'pageSizeBytes'],
    ['page_count', 'pageCount'],
    ['freelist_count', 'freePageCount'],
  ]) {
    try {
      const row = await db.get(`PRAGMA ${pragma}`);
      const value = row?.[pragma];
      if (!Number.isSafeInteger(value) || value < 0 || (pragma === 'page_size' && value === 0)) {
        throw new Error('The runtime did not return a valid PRAGMA value.');
      }
      database[key] = value;
    } catch (error) {
      database.errors.push({ pragma, message: String(error?.message ?? error) });
    }
  }

  if (database.pageSizeBytes !== null) {
    for (const [pages, key] of [
      [database.pageCount, 'allocatedBytes'],
      [database.freePageCount, 'reusableBytes'],
    ]) {
      const bytes = database.pageSizeBytes * pages;
      if (pages !== null && Number.isSafeInteger(bytes)) database[key] = bytes;
    }
  }

  return {
    measuredAt: new Date().toISOString(),
    cpu: {
      logicalCores: null,
      quotaCores: null,
      note: 'The SDK does not expose core count or CPU quota. This JS workload cannot determine core count or bot throughput.',
      probe: {
        algorithm: 'xorshift32',
        iterations: CPU_ITERATIONS,
        elapsedMs,
        iterationsPerSecond: elapsedMs > 0 ? Math.round(CPU_ITERATIONS * 1000 / elapsedMs) : null,
        checksum: checksum >>> 0,
        clock: hasPerformanceClock ? 'performance.now' : 'Date.now',
        note: 'Elapsed time includes runtime pauses. Throughput is unknown when the clock returns zero or an invalid duration.',
      },
    },
    memory: {
      limitBytes: null,
      availableBytes: null,
      probe: memoryProbe,
      note: 'The SDK does not expose the RAM limit. Success confirms only that 4 MiB was allocated and written in this invocation; it does not establish a memory limit.',
    },
    disk: {
      filesystemAvailable: false,
      totalBytes: null,
      freeBytes: null,
      note: 'The runtime has no filesystem access. Persistent data is available through SQLite; disk capacity and free space are not exposed.',
      database,
    },
  };
}
