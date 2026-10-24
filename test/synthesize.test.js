import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

test('synthesize-report produces valid Markdown and honors GITHUB_STEP_SUMMARY', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tg-summary-test-'));
  const summaryFile = join(directory, 'step_summary.md');

  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['experiments/synthesize-report.mjs'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryFile,
        },
      }
    );

    assert.match(stdout, /Successfully generated synthesis report/);
    assert.match(stdout, /Appended synthesis report to \$GITHUB_STEP_SUMMARY/);

    const summaryContent = await readFile(summaryFile, 'utf8');
    assert.match(summaryContent, /Telegram Serverless Resource Limits & Capacity Report/);
    assert.match(summaryContent, /JS Heap Boundary/);
    assert.match(summaryContent, /ArrayBuffer Max Write/);
    assert.match(summaryContent, /Synchronous CPU Time/);
    assert.match(summaryContent, /SQLite BLOB Storage/);
    assert.match(summaryContent, /Concurrency Ceiling/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
