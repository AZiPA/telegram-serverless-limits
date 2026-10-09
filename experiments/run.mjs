import { requestProbe, printProbe, probeAppId } from './rpc.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

function memoryFailure(result) {
  if (result.ok) return false;
  if (!/memory|heap|allocation|array.?buffer/i.test(`${result.errorType} ${result.error}`)) {
    throw new Error(`Failure is not a confirmed memory boundary: ${result.error}`);
  }
  return true;
}

function storageFull(result) {
  return /Sqlite database size limit exceeded|\[13\] database or disk is full/.test(result.error);
}

async function cleanupStorage(state) {
  assert.equal(state.appId, await probeAppId(), 'Storage probe belongs to another bot');
  const dropped = await requestProbe({ kind: 'storage', action: 'drop', table: state.table });
  printProbe(dropped);
  const tables = await requestProbe({ kind: 'sql', query: 'tables' });
  printProbe(tables);
  state.cleaned = dropped.ok && tables.ok && !tables.value.some(row => row.name === state.table);
  await writeFile('reports/storage-state.json', JSON.stringify(state, null, 2) + '\n');
  assert.ok(state.cleaned, 'Probe table cleanup was not confirmed');
}

const phase = process.argv[2] || 'metadata';
if (phase === 'metadata') {
  printProbe(await requestProbe({ kind: 'metadata' }));
  printProbe(await requestProbe({ kind: 'sql', query: 'tables' }));
  printProbe(await requestProbe({ kind: 'transaction-check' }));
} else if (phase === 'single') {
  if (!process.argv[3]) throw new Error('Pass a JSON probe input');
  printProbe(await requestProbe(JSON.parse(process.argv[3])));
} else if (phase === 'memory') {
  for (const kind of ['buffer', 'heap']) {
    let low = 0;
    let high = null;
    for (const mib of [4, 8, 16, 32, 64, 128, 256, 512, 1024]) {
      if (kind === 'heap' && mib > 512) break;
      const result = await requestProbe({ kind, mib });
      printProbe(result);
      if (memoryFailure(result)) { high = mib; break; }
      low = mib;
    }
    if (high !== null) {
      while (high - low > 1) {
        const mib = Math.floor((high + low) / 2);
        const result = await requestProbe({ kind, mib });
        printProbe(result);
        if (memoryFailure(result)) high = mib;
        else low = mib;
      }
    }
    console.log(JSON.stringify({ kind, largestSuccessfulMiB: low, smallestFailedMiB: high }));
  }
} else if (phase === 'cpu') {
  const results = [];
  for (const iterations of [10_000_000, 100_000_000, 500_000_000, 1_000_000_000,
    2_000_000_000, 4_000_000_000, 8_000_000_000, 16_000_000_000, 30_000_000_000]) {
    const result = await requestProbe({ kind: 'cpu', iterations, phase: 'boundary' });
    printProbe(result);
    results.push(result);
    await writeFile('reports/cpu-boundary.json', JSON.stringify(results, null, 2) + '\n');
    if (!result.ok) break;
    assert.equal(result.value.iterations, iterations);
  }
} else if (phase === 'parallel') {
  const batches = [];
  for (const concurrency of [1, 2, 4, 8, 16]) {
    for (let trial = 1; trial <= 3; trial++) {
      const started = performance.now();
      const results = await Promise.all(Array.from({ length: concurrency }, (_, job) =>
        requestProbe({ kind: 'cpu', iterations: 250_000_000, phase: 'parallel', concurrency, trial, job },
          { retryRateLimit: false })));
      const batch = { concurrency, trial, wallMs: performance.now() - started, results };
      batches.push(batch);
      await writeFile('reports/parallel.json', JSON.stringify(batches, null, 2) + '\n');
      console.log(JSON.stringify({ concurrency, trial, wallMs: batch.wallMs,
        serverMs: results.map(result => result.serverMs), errors: results.filter(result => !result.ok) }));
      assert.ok(results.every(result => result.ok), 'A concurrent invocation failed');
      assert.ok(results.every(result => result.value.checksum === results[0].value.checksum));
    }
  }
} else if (phase === 'confirm') {
  for (let trial = 1; trial <= 3; trial++) {
    for (const mib of [127, 128]) printProbe(await requestProbe({ kind: 'heap', mib, trial }));
    for (const iterations of [1_000_000_000, 4_000_000_000]) {
      printProbe(await requestProbe({ kind: 'cpu', iterations, phase: 'confirm', trial }));
    }
  }
} else if (phase === 'cleanup') {
  await cleanupStorage(JSON.parse(await readFile('reports/storage-state.json', 'utf8')));
} else if (phase === 'storage') {
  await mkdir('reports', { recursive: true });
  const statePath = 'reports/storage-state.json';
  let previous;
  try { previous = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && !previous.cleaned) throw new Error('Unfinished storage probe; clean its recorded table first');
  const state = { table: '__tg_probe_' + randomBytes(6).toString('hex'),
    appId: await probeAppId(), created: false, cleaned: false };
  await writeFile(statePath, JSON.stringify(state) + '\n');
  const input = { kind: 'storage', table: state.table };
  const created = await requestProbe({ ...input, action: 'create' });
  printProbe(created);
  if (!created.ok) throw new Error('Could not create the probe table');
  state.created = true;
  state.appId = created.appId;
  await writeFile(statePath, JSON.stringify(state) + '\n');
  let storedMiB = 0;
  try {
    storageGrowth: for (const targetMiB of [1, 4, 16, 32, 64, 128, 256, 512]) {
      while (storedMiB < targetMiB) {
        const mib = Math.min(8, targetMiB - storedMiB);
        const result = await requestProbe({ ...input, action: 'fill', mib });
        printProbe(result);
        if (!result.ok) {
          state.firstFailure = result;
          await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
          if (!storageFull(result)) {
            throw new Error(`Storage failed for another reason: ${result.error}`);
          }
          const status = await requestProbe({ ...input, action: 'status' });
          printProbe(status);
          assert.ok(status.ok, 'Could not inspect data after a rejected insert');
          state.maximumPayloadBytes = status.value.payloadBytes;
          for (const blocks of [16, 1]) {
            for (let step = 0; step < 16; step++) {
              const refined = await requestProbe({ ...input, action: 'fill', blocks });
              printProbe(refined);
              if (!refined.ok) {
                if (!storageFull(refined)) {
                  throw new Error(`Storage refinement failed: ${refined.error}`);
                }
                state.smallestRejectedAppendBytes = blocks * 65536;
                break;
              }
              assert.ok(refined.value.payloadBytes > state.maximumPayloadBytes);
              state.maximumPayloadBytes = refined.value.payloadBytes;
            }
          }
          state.storedMiB = state.maximumPayloadBytes / 1048576;
          const finalStatus = await requestProbe({ ...input, action: 'status' });
          printProbe(finalStatus);
          assert.ok(finalStatus.ok);
          assert.equal(finalStatus.value.payloadBytes, state.maximumPayloadBytes);
          console.log(JSON.stringify({ maximumPayloadBytes: state.maximumPayloadBytes,
            smallestRejectedAppendBytes: state.smallestRejectedAppendBytes }));
          break storageGrowth;
        }
        storedMiB += mib;
        assert.equal(result.value.payloadBytes, storedMiB * 1024 * 1024);
        assert.equal(result.value.rows, storedMiB * 16);
        state.storedMiB = storedMiB;
        await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
      }
      console.log(JSON.stringify({ storageVerifiedMiB: storedMiB }));
    }
  } finally {
    await cleanupStorage(state);
  }
} else {
  throw new Error('Expected metadata, single, memory, cpu, parallel, confirm, storage or cleanup');
}
