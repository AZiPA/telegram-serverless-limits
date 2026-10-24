# Telegram Serverless Resource Limits & Capacity Report

**Synthesized at:** 2026-10-24T17:56:00.258Z  
**Target Environment:** Telegram Cloud Serverless Runtime  
**Management Endpoint:** `POST /<appId>/manage/run`  
**Tooling:** `@tgcloud/cli` v0.2.0, reproducible Node.js in-memory probes

---

## Executive Summary & Capacity Matrix

The following matrix benchmarks the measured boundaries of the Telegram Serverless execution sandbox compared against the verified October 2026 baseline:

| Metric | Measured Threshold | Platform Behavior / Error Type | Baseline Comparison |
| :--- | :--- | :--- | :--- |
| **JS Heap Boundary** | 127 MiB pass / 128 MiB fail | `Terminated: Memory limit exceeded` | 0 MiB (identical to 128 MiB boundary) |
| **ArrayBuffer Max Write** | 6.0 GiB fill / 8.0 GiB edge | Allocation vs CPU timer exceeded (inconsistent 8 GiB boundary) | Matches baseline: 6 GiB fill verified; 8 GiB alloc unstable; 8 GiB + 1B rejected |
| **Synchronous CPU Time** | ~3005.6 ms (~3.0 s) | `Terminated: CPU timer exceeded` | Baseline ~3,002.8–3,016.5 ms (Δ 0.0 ms) |
| **SQLite BLOB Storage** | 520,093,696 bytes (496.0 MiB) | `Sqlite database size limit exceeded` | Baseline 520,093,696 bytes (~496.0 MiB, 64 KiB BLOBs) |
| **Concurrency Ceiling** | 8 concurrent jobs | Linear scaling up to 8×; HTTP 429 RATE_LIMITED at 16 calls | 8× parallel throughput confirmed (~401 ms); 16 calls rate-limited (retry_after: 7) |

---

## Detailed Investigation & Analysis

### 1. JavaScript Heap Memory
- **Element Workload**: Non-typed JavaScript arrays holding numeric values (`Array(1024 * 1024 / 8)`).
- **Observed Ceiling**: Workload allocations up to **127 MiB** pass all integrity checks consistently.
- **Failure Trigger**: Exceeding **128 MiB** immediately terminates the isolate with `Terminated: Memory limit exceeded`.
- **Architectural Note**: This represents the usable JS element payload within the V8 isolate; runtime internal metadata and SDK objects reduce raw headroom.

### 2. Binary ArrayBuffer Storage
- **Full Page Write Check (`fill`)**: Up to **6.0 GiB** (6,442,450,944 bytes) was allocated, filled via 16 MiB slices, and verified at every 4 KiB memory page and terminal byte without corruption.
- **Virtual Allocation vs Physical RSS (`edges`)**: Single buffers of **8.0 GiB** (8,589,934,592 bytes) allocate successfully in isolated trials, but exhibit non-deterministic memory rejections across identical invocations.
- **Hard Rejection Ceiling**: Allocating **8 GiB + 1 byte** (8,589,934,593 bytes) fails 100% of the time across single and chunked views with `Terminated: Memory limit exceeded`. Full writes of 8 GiB trigger `Terminated: CPU timer exceeded` before completing page checks.

### 3. Continuous Synchronous CPU Time
- **Workload**: Deterministic PRNG (`xorshift32`) compute loops without I/O or asynchronous pauses.
- **Limit Enforcement**: The server's monotonic runtime monitor forcefully terminates execution at **~3005.6 ms (~3.0 s)** with `Terminated: CPU timer exceeded`.
- **Clock Behavior**: Inside synchronous execution, `Date.now()` remains frozen and `performance.now()` is unavailable in the sandbox, confirming time slicing is enforced externally by the container supervisor.
- **Throughput**: 1 billion `xorshift32` iterations execute in approximately ~1,366 ms server time.

### 4. SQLite Persistent Storage Quota
- **Probe Table Architecture**: Randomly generated probe table `__tg_probe_<hex>` populated with 64 KiB BLOBs via SQLite recursive CTEs.
- **Capacity Ceiling**: Successfully stores **520,093,696 bytes (496.0 MiB)** of raw binary payload.
- **Enforcement Error**: Any subsequent insert encounters:
  ```text
  Sqlite database size limit exceeded
  Sqlite query failed (commit) [13] database or disk is full
  ```
- **Database Administration**: Administrative PRAGMAs (`page_size`, `page_count`, `freelist_count`), `VACUUM`, and `SAVEPOINT` are strictly denied by SQLite authorizer hooks. Logical cleanup via `DROP TABLE` successfully reclaims logical table space.

### 5. Concurrency & Management API Rate Limits
- **Parallel Scaling**: Concurrent requests demonstrate near-linear horizontal scaling across 1, 2, 4, and 8 simultaneous workers (throughput scaling: **7.96×** at 8 workers).
- **Rate Limit Boundary**: Submitting 16 concurrent requests trips the Telegram Cloud Management API rate limiter, returning:
  ```json
  { "ok": false, "error_type": "RATE_LIMITED", "parameters": { "retry_after": 7 } }
  ```
- **Operational Takeaway**: The 16-call limit reflects management endpoint throttling (`/manage/run`), not the underlying serverless execution concurrency capacity for production webhooks/handlers.

---

## Safety & Cleanup Verification
- Storage state file: `reports/storage-state.json`
- Automated cleanup verification routine dropped all temporary tables (`DROP TABLE IF EXISTS "__tg_probe_*"`).
- Verification check confirmed: `SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'` returned 0 probe tables.
