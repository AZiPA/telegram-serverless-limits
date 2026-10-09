import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { resolveToken } from '@tgcloud/cli/src/core/credentials.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

const source = await readFile(new URL('./runtime.js', import.meta.url), 'utf8');
const runtimeSha256 = createHash('sha256').update(source).digest('hex');
const minimalSource = await readFile(new URL('./buffer-isolated.js', import.meta.url), 'utf8');
const minimalSha256 = createHash('sha256').update(minimalSource).digest('hex');
const reports = 'reports';
const credentials = resolveToken();

export async function probeAppId() {
  return (await credentials).split(':')[0];
}

// shortcut: token resolution uses CLI 0.2.0 internals; recheck when upgrading the CLI.
export async function requestProbe(input, { timeoutMs = 90_000, retryRateLimit = true, retries = 3, runtime = 'sdk' } = {}) {
  if (!['sdk', 'minimal'].includes(runtime)) throw new Error('Unknown probe runtime');
  const token = await credentials;
  const appId = token.split(':')[0];
  const base = (process.env.TG_CLOUD_API_URL || 'https://cloud.telegram.org').replace(/\/+$/, '');
  const beta = process.env.TGCLOUD_BETA === '1' ? '/beta' : '';
  const started = performance.now();
  let record;
  try {
    const response = await fetch(`${base}${beta}/${appId}/manage/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        module: 'endpoints/capacityProbe',
        sources: { 'endpoints/capacityProbe': runtime === 'minimal' ? minimalSource : source },
        args: input,
        ctx: {},
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const envelope = await response.json();
    const result = envelope.result;
    record = {
      ok: envelope.ok === true && !result?.result?.__error,
      httpStatus: response.status,
      serverMs: Number.isFinite(result?.time ?? envelope.parameters?.time)
        ? (result?.time ?? envelope.parameters.time) * 1000 : null,
      value: result?.result,
      error: envelope.description ?? envelope.error ?? result?.result?.message ?? null,
      errorType: envelope.error_type ?? null,
      errorCode: envelope.error_code ?? null,
      parameters: envelope.parameters ?? null,
      logs: result?.log ?? envelope.parameters?.log ?? [],
    };
  } catch (error) {
    record = { ok: false, error: error.message, errorType: error.name, serverMs: null };
  }
  record = { at: new Date().toISOString(), appId, runtime,
    runtimeSha256: runtime === 'minimal' ? minimalSha256 : runtimeSha256,
    input, roundTripMs: performance.now() - started, ...record };
  await mkdir(reports, { recursive: true });
  const safeRecord = JSON.parse(JSON.stringify(record).split(token).join('[REDACTED]'));
  await appendFile('reports/probes.jsonl', JSON.stringify(safeRecord) + '\n');
  const retryAfter = safeRecord.parameters?.retry_after;
  if (retryRateLimit && retries > 0 && safeRecord.httpStatus === 429 &&
      safeRecord.errorType === 'RATE_LIMITED' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    const seconds = Math.ceil(retryAfter) + 1;
    console.log(JSON.stringify({ waitingForRateLimitSeconds: seconds }));
    await delay(seconds * 1000);
    return requestProbe(input, { timeoutMs, retryRateLimit, retries: retries - 1, runtime });
  }
  return safeRecord;
}

export function printProbe(record) {
  console.log(JSON.stringify(record));
}
