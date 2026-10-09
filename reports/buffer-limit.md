# Telegram Serverless ArrayBuffer memory limit

**A stable byte-exact buffer limit was not confirmed.** Across 84 buffer probes on October 9, 2026, the largest successful allocation was **8 GiB**, but identical requests also failed. The largest fully written buffer was **6 GiB**, checked at every 4 KiB page and at its last byte.

| Test | Observation |
| --- | --- |
| One buffer of **8,589,934,592 bytes (8 GiB)** | Both successful allocation with last-byte access and `Terminated: Memory limit exceeded`. |
| **8,589,934,593 bytes (8 GiB + 1)** | **13/13 rejections**, across single-buffer and chunked layouts. |
| Identical minimal JavaScript, no SDK, exactly 8 GiB | **1 success, 2 failures** in the control series. SDK overhead alone does not explain the variation. |
| Full fill and page checks at **6,442,450,944 bytes (6 GiB)** | Passed: **1,572,864 pages** checked, about **832 ms** of server time. |
| Full 8 GiB test, no SDK | Stopped after **3,029.8 ms** with `Terminated: CPU timer exceeded`. This is not a memory-size rejection. |
| Multiple 64 MiB buffers totaling 8 GiB or more | Memory rejections also occurred. Splitting the allocation did not remove the observed constraint. |

The [JSON summary](2026-10-09/buffer-summary.json) and [invocation log](2026-10-09/probes.jsonl) contain the evidence, with bot identifiers redacted.

## Why there is no exact number

A byte-by-byte binary search initially found **8,589,571,387 bytes passing** and **8,589,571,388 bytes failing**. The supposedly failing size then passed on repetition. The candidate remains `confirmed: false` in the summary.

The minimal runtime also failed, passed, then failed at exactly 8 GiB with the same input and source SHA-256:

```text
65f6e3b3b4f8d612aaeccec4cfce4a4d9d8434794b4bf1f97fe77f39148748a5
```

It kept the buffer alive through 100 million CPU iterations before checking the final byte. The cause of the varying outcomes is unknown. An observed 8 GiB success cannot be treated as guaranteed memory or a known platform setting.

## Allocation versus full writes

`edges` allocates an `ArrayBuffer`, writes and reads its first and last bytes, and can hold it through a CPU loop. This checks an addressable object, not physical commitment of every page.

`fill` writes the entire buffer through 16 MiB `Uint8Array` views, then checks each 4 KiB page and the last byte. It does not compare every byte individually.

The main runtime accepts edge tests up to 64 GiB; the minimal runtime accepts up to 16 GiB. Thus **8 GiB + 1** was rejected by the platform, not by the local size validator. Full fills are capped at 8 GiB. CPU timeouts, HTTP 429 and network errors are not counted as proof of a memory boundary.

## Reproduce

Use a disposable test bot with the [CLI configured](../README.md#try-a-small-diagnostic). These commands allocate several GiB:

```bash
node experiments/buffer-limit.mjs single 8589934592 edges
node experiments/buffer-limit.mjs single 8589934593 edges
node experiments/buffer-limit.mjs minimal 8589934592 edges
node experiments/buffer-limit.mjs single 6442450944 fill
```

To search an interval with one-byte precision:

```bash
node experiments/buffer-limit.mjs boundary 8522825728 8589934592 edges
```

The search checks both endpoints and repeats the adjacent candidate sizes. If outcomes disagree, it exits with an error instead of marking the candidate confirmed. Even a passing search would establish repeatability only for those trials. New logs and candidates go to ignored files directly under `reports/`; the published snapshot is unchanged. These buffer probes do not write to the database.

Source: [main runtime](../experiments/runtime.js), [minimal runtime without SDK](../experiments/buffer-isolated.js), [probe runner](../experiments/buffer-limit.mjs).
