import * as sdk from 'sdk';

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export default async function (input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Expected a probe input object');
  }
  const startedAt = Date.now();
  if (input.kind === 'metadata') {
    return {
      startedAt,
      globals: Object.getOwnPropertyNames(globalThis),
      sdkExports: Object.keys(sdk),
      hardwareConcurrency: globalThis.navigator?.hardwareConcurrency ?? null,
      performanceAvailable: typeof globalThis.performance,
    };
  }

  if (input.kind === 'cpu') {
    const iterations = integer(input.iterations, 1, 30_000_000_000);
    let checksum = integer(input.seed ?? 0x12345678, 1, 0xffffffff);
    for (let i = 0; i < iterations; i++) {
      checksum ^= checksum << 13;
      checksum ^= checksum >>> 17;
      checksum ^= checksum << 5;
    }
    return { startedAt, iterations, checksum: checksum >>> 0 };
  }

  if (input.kind === 'buffer' || input.kind === 'heap') {
    const mib = integer(input.mib, 1, input.kind === 'buffer' ? 1024 : 512);
    const blocks = [];
    for (let i = 0; i < mib; i++) {
      const block = input.kind === 'buffer'
        ? new Uint8Array(1024 * 1024)
        : new Array(1024 * 1024 / 8);
      block.fill(input.kind === 'buffer' ? i % 251 + 1 : i + 0.5);
      blocks.push(block);
    }
    let checksum = 0;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const expected = input.kind === 'buffer' ? i % 251 + 1 : i + 0.5;
      for (let offset = 0; offset < block.length; offset += 4096) {
        if (block[offset] !== expected) throw new Error('Memory verification failed');
      }
      if (block[block.length - 1] !== expected) throw new Error('Memory verification failed');
      checksum += block[0] + block[block.length - 1];
    }
    return {
      startedAt,
      kind: input.kind,
      mib,
      payloadBytes: mib * 1024 * 1024,
      elements: blocks.reduce((sum, block) => sum + block.length, 0),
      checksum,
    };
  }

  if (input.kind === 'binary') {
    if (!['edges', 'fill'].includes(input.touch)) throw new Error('Unknown buffer touch mode');
    if (input.fullView !== undefined && typeof input.fullView !== 'boolean') throw new Error('fullView must be boolean');
    const totalBytes = integer(input.bytes, 1, input.touch === 'fill' ? 8 * 1024 ** 3 : 64 * 1024 ** 3);
    const chunkBytes = integer(input.chunkBytes ?? totalBytes, 1, totalBytes);
    if (Math.ceil(totalBytes / chunkBytes) > 4096) throw new Error('Too many buffers');
    const buffers = [];
    let stage = 'allocate';
    try {
      console.log('binary:allocate', { totalBytes, chunkBytes, touch: input.touch });
      let allocatedBytes = 0;
      while (allocatedBytes < totalBytes) {
        const size = Math.min(chunkBytes, totalBytes - allocatedBytes);
        const buffer = new ArrayBuffer(size);
        if (buffer.byteLength !== size) throw new Error('Unexpected buffer length');
        buffers.push(buffer);
        allocatedBytes += size;
        if (chunkBytes < totalBytes && (input.traceBlocks || allocatedBytes % (1024 ** 3) === 0)) console.log('binary:block', allocatedBytes);
      }
      console.log('binary:allocated', allocatedBytes);
      if (input.fullView) {
        stage = 'whole-view';
        for (const buffer of buffers) {
          if (new Uint8Array(buffer).byteLength !== buffer.byteLength) throw new Error('Unexpected Uint8Array length');
        }
      }
      let settleChecksum = 0;
      if (input.settle) {
        stage = 'settle';
        settleChecksum = 0x12345678;
        for (let i = 0; i < 100_000_000; i++) {
          settleChecksum ^= settleChecksum << 13;
          settleChecksum ^= settleChecksum >>> 17;
          settleChecksum ^= settleChecksum << 5;
        }
        console.log('binary:settled', settleChecksum >>> 0);
      }
      stage = 'touch';
      for (let i = 0; i < buffers.length; i++) {
        const buffer = buffers[i];
        const value = i % 251 + 1;
        if (input.touch === 'fill') {
          for (let offset = 0; offset < buffer.byteLength; offset += 16 * 1024 * 1024) {
            new Uint8Array(buffer, offset, Math.min(16 * 1024 * 1024, buffer.byteLength - offset)).fill(value);
          }
        } else {
          new Uint8Array(buffer, 0, 1)[0] = value;
          new Uint8Array(buffer, buffer.byteLength - 1, 1)[0] = value;
        }
      }
      console.log('binary:touched', input.touch);
      stage = 'verify';
      let verifiedPages = 0;
      let checksum = 0;
      for (let i = 0; i < buffers.length; i++) {
        const buffer = buffers[i];
        const expected = i % 251 + 1;
        if (input.touch === 'fill') {
          for (let start = 0; start < buffer.byteLength; start += 16 * 1024 * 1024) {
            const view = new Uint8Array(buffer, start, Math.min(16 * 1024 * 1024, buffer.byteLength - start));
            for (let offset = 0; offset < view.length; offset += 4096) {
              if (view[offset] !== expected) throw new Error('Buffer data mismatch');
              verifiedPages++;
            }
          }
        }
        const first = new Uint8Array(buffer, 0, 1)[0];
        const last = new Uint8Array(buffer, buffer.byteLength - 1, 1)[0];
        if (first !== expected || last !== expected) throw new Error('Buffer edge mismatch');
        checksum += first + last;
      }
      return { startedAt, totalBytes, chunkBytes, count: buffers.length, touch: input.touch,
        fullView: Boolean(input.fullView), settleChecksum: settleChecksum >>> 0, verifiedPages, checksum };
    } catch (error) {
      throw new Error(`binary:${stage}: ${error.name}: ${error.message}`);
    }
  }

  if (input.kind === 'sql') {
    const queries = {
      tables: "SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      version: 'SELECT sqlite_version() AS version',
      health: 'SELECT 1 AS ok',
      blob: 'SELECT length(randomblob(16)) AS bytes',
      dbstat: 'SELECT sum(pgsize) AS bytes FROM dbstat',
    };
    if (!Object.hasOwn(queries, input.query)) throw new Error('Unknown read-only query');
    return sdk.db.all(queries[input.query]);
  }

  if (input.kind === 'compact-empty-db') {
    const tables = await sdk.db.all("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'");
    if (tables.length !== 0) throw new Error('Compaction is restricted to an empty database');
    await sdk.db.run('VACUUM');
    return { compacted: true };
  }

  if (input.kind === 'transaction-check') {
    await sdk.db.run('SAVEPOINT capacity_check');
    try {
      return await sdk.db.get('SELECT 1 AS ok');
    } finally {
      await sdk.db.run('ROLLBACK TO capacity_check');
      await sdk.db.run('RELEASE capacity_check');
    }
  }

  if (input.kind === 'storage') {
    if (typeof input.table !== 'string' || !/^__tg_probe_[a-f0-9]{12}$/.test(input.table)) {
      throw new Error('Invalid probe table name');
    }
    const name = `"${input.table}"`;
    if (input.action === 'check') {
      await sdk.db.run(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)`);
      try {
        await sdk.db.run(`INSERT INTO ${name}(payload) VALUES(randomblob(1024))`);
        return await sdk.db.get(`SELECT count(*) AS rows, length(payload) AS bytes FROM ${name}`);
      } finally {
        await sdk.db.run(`DROP TABLE ${name}`);
      }
    }
    if (input.action === 'create') {
      await sdk.db.run(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)`);
      return { created: input.table };
    }
    if (input.action === 'drop') {
      await sdk.db.run(`DROP TABLE IF EXISTS ${name}`);
      return { dropped: input.table };
    }
    if (input.action === 'fill') {
      const chunks = input.blocks === undefined
        ? integer(input.mib, 1, 8) * 16 : integer(input.blocks, 1, 128);
      await sdk.db.run(`WITH RECURSIVE chunks(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM chunks WHERE n < :chunks
      ) INSERT INTO ${name}(payload) SELECT randomblob(65536) FROM chunks`, { ':chunks': chunks });
    } else if (input.action !== 'status') {
      throw new Error('Unknown storage action');
    }
    return sdk.db.get(`SELECT count(*) AS rows, coalesce(sum(length(payload)), 0) AS payloadBytes FROM ${name}`);
  }

  throw new Error('Unknown probe kind');
}
