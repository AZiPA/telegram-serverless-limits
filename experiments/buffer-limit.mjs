import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { requestProbe } from './rpc.mjs';

const GiB = 1024 ** 3;
const phase = process.argv[2] || 'survey';
const runtime = phase === 'minimal' ? 'minimal' : 'sdk';
const output = 'reports/buffer-boundary.json';
let history;
try { history = JSON.parse(await readFile(output, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; history = []; }

function allocationFailure(result) {
  if (result.ok) return false;
  if (/binary:allocate:.*(?:RangeError|allocation|length)/i.test(result.error)) return true;
  const messages = (result.logs ?? []).map(entry => entry.m ?? entry.M ?? '');
  return result.error === 'Terminated: Memory limit exceeded' &&
    messages.some(message => message.startsWith('binary:allocate '));
}

async function run(bytes, touch, chunkBytes, trial, fullView = false) {
  const input = { kind: 'binary', bytes, touch };
  if (touch === 'edges') input.settle = true;
  if (chunkBytes !== undefined) input.chunkBytes = chunkBytes;
  if (fullView) input.fullView = true;
  const result = await requestProbe(input, { runtime });
  if (trial !== undefined) result.experimentTrial = trial;
  history.push(result);
  await writeFile(output, JSON.stringify(history, null, 2) + '\n');
  console.log(JSON.stringify({ bytes, touch, chunkBytes, ok: result.ok, serverMs: result.serverMs,
    value: result.value, error: result.error, logs: result.logs }));
  if (result.ok) {
    assert.equal(result.value.totalBytes, bytes);
    assert.equal(result.value.count, Math.ceil(bytes / (chunkBytes ?? bytes)));
  }
  return result;
}

if (phase === 'survey') {
  for (const bytes of [GiB, 1.5 * GiB, 2 * GiB, 3 * GiB, 4 * GiB]) {
    const result = await run(bytes, 'fill');
    if (!result.ok) break;
  }
} else if (phase === 'reserve') {
  for (const bytes of [4, 8, 16, 32, 64].map(value => value * GiB)) {
    const result = await run(bytes, 'edges');
    if (!result.ok) break;
  }
} else if (phase === 'single' || phase === 'minimal') {
  const bytes = Number(process.argv[3]);
  const touch = process.argv[4] || 'edges';
  const chunkBytes = process.argv[5] === undefined ? undefined : Number(process.argv[5]);
  await run(bytes, touch, chunkBytes);
} else if (phase === 'boundary') {
  let low = Number(process.argv[3]);
  let high = Number(process.argv[4]);
  const touch = process.argv[5] || 'edges';
  assert.ok(Number.isSafeInteger(low) && Number.isSafeInteger(high) && low < high);
  assert.ok((await run(low, touch)).ok, 'Lower endpoint is not reproducibly successful');
  const failed = await run(high, touch);
  assert.ok(allocationFailure(failed),
    'Upper endpoint is not a confirmed ArrayBuffer allocation failure');
  while (high - low > 1) {
    const bytes = low + Math.floor((high - low) / 2);
    const result = await run(bytes, touch);
    if (result.ok) low = bytes;
    else {
      assert.ok(allocationFailure(result),
        'Different failure: cannot treat it as the same byte-length boundary');
      high = bytes;
    }
  }
  await writeFile('reports/buffer-candidate.json', JSON.stringify({
    largestSuccessfulBytes: low, smallestRejectedBytes: high, touch, confirmed: false,
  }, null, 2) + '\n');
  for (let trial = 1; trial <= 3; trial++) {
    assert.ok((await run(low, touch, undefined, trial)).ok);
    const result = await run(high, touch, undefined, trial);
    assert.ok(allocationFailure(result));
  }
  console.log(JSON.stringify({ largestSuccessfulBytes: low, smallestRejectedBytes: high, touch }));
  await writeFile('reports/buffer-candidate.json', JSON.stringify({
    largestSuccessfulBytes: low, smallestRejectedBytes: high, touch, confirmed: true,
  }, null, 2) + '\n');
} else if (phase === 'verify-limit') {
  const bytes = Number(process.argv[3]);
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 8 * GiB);
  for (const chunkBytes of [bytes, 64 * 1024 * 1024]) {
    const filled = await run(bytes, 'fill', chunkBytes, undefined, true);
    assert.ok(filled.ok, 'Full write/read at the candidate limit failed');
    assert.equal(filled.value.verifiedPages, Math.ceil(bytes / 4096));
    for (let trial = 1; trial <= 3; trial++) {
      assert.ok((await run(bytes, 'edges', chunkBytes, trial, true)).ok);
      const rejected = await run(bytes + 1, 'edges', chunkBytes === bytes ? bytes + 1 : chunkBytes, trial, true);
      assert.ok(allocationFailure(rejected), 'Candidate limit + 1 byte was not consistently rejected');
    }
  }
  console.log(JSON.stringify({ verifiedLimitBytes: bytes, rejectedBytes: bytes + 1,
    layouts: ['single', '64 MiB chunks'], fullWriteAndRead: true, boundaryTrialsPerLayout: 3 }));
} else {
  throw new Error('Expected survey, reserve, single, minimal, boundary or verify-limit');
}
