# Telegram Serverless Limits

How much memory, CPU time and SQLite storage does **Telegram Serverless** give a bot? This project measures those limits, tests concurrent calls, and includes JavaScript probes you can run yourself.

Tested on **October 9, 2026**, during early access, using `@tgcloud/cli` 0.2.0. These are observations from one bot, not official Telegram quotas. See the [official Serverless documentation](https://core.telegram.org/bots/serverless) for the platform API.

## Measured limits

| Resource | What worked, and where it stopped |
| --- | --- |
| **JavaScript heap** | **127 MiB** of numeric-array payload passed 4/4 times. **128 MiB** failed 4/4 with `Memory limit exceeded`. Roughly a 128 MiB heap boundary for this workload. |
| **Binary buffers (`ArrayBuffer`)** | **6 GiB** fully written and checked page by page. **8 GiB** allocated in some runs, but identical requests also failed. No stable byte-exact limit confirmed. |
| **CPU time** | Continuous computation stopped after **3,002.8–3,016.5 ms** with `CPU timer exceeded`: about **3 seconds**. Network-waiting handlers were not timed to their limit. |
| **SQLite storage** | **496 MiB** of BLOB payload stored and counted. An additional **1 MiB** failed with `database or disk is full`. Schema and indexes affect usable space. |
| **Concurrency** | **8 simultaneous CPU calls** passed three batches, reaching about **7.96×** the single-call throughput. A 16-call batch hit HTTP 429 on the management API. |
| **Physical resources** | CPU core count, total RAM and disk capacity are not exposed. There is no filesystem access. |

JS heap and binary buffers behaved differently. An 8 GiB allocation does **not** establish an 8 GiB RAM guarantee; eight concurrent calls do **not** establish eight dedicated cores.

Methods and evidence: [CPU, memory, storage and concurrency](reports/capacity.md) · [binary buffer investigation](reports/buffer-limit.md) · [JSON summary](reports/2026-10-09/summary.json).

## Try a small diagnostic

Requires Node.js 24+ and a bot with Telegram Serverless enabled.

```bash
git clone https://github.com/DaYzTm/telegram-serverless-limits.git
cd telegram-serverless-limits
npm install --no-package-lock
npx tgcloud login
npm run diagnose
```

Get the CLI token from the [BotFather Mini App](https://t.me/BotFather?startapp): **your bot → Settings → Serverless → CLI Access → Access token**. Its format is `app<id>:<secret>`; it is separate from the Bot API token. For CI, use `TGCLOUD_TOKEN`. Local credentials in `.tgcloud/` are ignored by Git.

Run `login` directly in an interactive terminal. Wrappers such as `rtk proxy` hide the TTY and cause the “requires an interactive terminal” error.

`diagnose` runs on Telegram, allocates 4 MiB, and attempts read-only SQLite metadata queries. Unavailable values remain `null`. It does not deploy modules or change webhooks. **Do not use `tgcloud push` from this folder on an existing bot:** it can delete cloud modules absent locally.

## Run the larger probes

Follow the [reproduction instructions](reports/capacity.md#reproduce) or [buffer commands](reports/buffer-limit.md#reproduce). Use a disposable test bot: the storage probe fills the SQLite quota.

New results stay in ignored `reports/*.json` and `reports/*.jsonl` files. The published [October 9 snapshot](reports/2026-10-09/) stays unchanged. Run local checks with `npm test`.
