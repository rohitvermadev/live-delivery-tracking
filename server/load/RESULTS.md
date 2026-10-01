# Location write measurements

`POST /api/location` writes one latest point per order. `STORE=postgres` upserts a row. `STORE=redis` overwrites one key.

## Setup

| | |
| --- | --- |
| Tool | k6, `server/load/location.js` |
| Load shape | Virtual users loop as fast as the server answers. No fixed rate. |
| Duration | 20 seconds |
| Orders | 1,000 ids (`ord_0` … `ord_999`) |
| Write | One upsert, or one Redis `SET`, per request. A repeated order overwrites its row or key. |
| Machine | k6, Node, Postgres, and Redis share one Windows laptop. Postgres and Redis run in Docker. |

Finished requests are responses k6 received. In every run below, all of them were HTTP 200.

## Comparison

| Store | Virtual users | Pool | Finished / sec | p(95) | Failures |
| --- | --- | --- | --- | --- | --- |
| Postgres | 20 | 10 (default) | 724 | 43 ms | 0 |
| Postgres | 50 | 10 | 733 | 96 ms | 0 |
| Postgres | 100 | 10 | 696 | 193 ms | 0 |
| Postgres | 100 | 50 | 725 | 259 ms | 0 |
| Redis | 100 | — | 1,989 | 71 ms | 0 |
| Redis | 200 | — | 1,912 | 165 ms | 0 |

Twenty seconds at about 700 finished requests per second is about 14,000 responses. The totals stayed in that band because the rate did not rise. More users increased wait time, not throughput.

## What was ruled out

**The connection pool.** With the default pool, Postgres showed about 12 sessions during a check. One was the `psql` session, so the app held about 10, the `pg` default. Raising the pool to 50 (`server/config/db.js`) raised sessions to 52. Throughput stayed near 725/sec, and p(95) got worse (193 ms to 259 ms).

**Node and k6.** During a later 100-user run the API process used about 0% CPU. It was waiting on Postgres. k6 was not saturated. Redis was under 1% CPU and is not on this write path.

**Postgres CPU.** The Postgres container used 32–42% CPU while the test ran, then fell to 0% when it stopped. The database was not out of CPU.

## Bottleneck

Each ping is one transaction. Postgres calls `fsync` on the write-ahead log before it reports success. Across one 100-user run, `pg_stat_wal` counted about 11,500 WAL syncs for about 13,000 upserts: roughly one disk sync per ping.

That run finished 654 requests/sec with p(95) at 214 ms. It was slightly slower than the table above because Postgres was queried for wait events during the test. The sync rate still landed near 600–700 per second, which matches the ceiling in the table.

On this machine the bottleneck is Postgres commit durability. The Docker disk confirms about 700 transaction syncs per second. More concurrency does not raise that number.

## Redis, 100 virtual users

Same script. Server started with `STORE=redis`. Each request is one `SET` on `location:order:{orderId}` with a 45 second TTL. No Postgres write on this path.

| | |
| --- | --- |
| Requests/sec | 1,989 |
| Total requests | 39,835 |
| Median | 48 ms |
| p(95) | 71 ms |
| Max | 179 ms |
| Failures | 0 |

Against Postgres at the same concurrency, Redis finished about 2.7 times as many requests (725/sec to 1,989/sec) and p(95) fell from 259 ms to 71 ms. The key does not wait for a disk sync on every ping.

One hundred users at about 50 ms each can complete about 2,000 requests/sec (`100 / 0.05`). That run matched the formula, so it did not prove a ceiling.

## Redis, 200 virtual users

Same script and `STORE=redis`.

| | |
| --- | --- |
| Requests/sec | 1,912 |
| Total requests | 38,466 |
| Median | 96 ms |
| p(95) | 165 ms |
| Max | 662 ms |
| Failures | 0 |

The rate did not climb (1,989/sec to 1,912/sec). p(95) rose from 71 ms to 165 ms. Same shape as the Postgres ceiling: more users waited, and finished writes stayed flat. On this laptop the Redis path tops out near **1,900 requests/sec**. Postgres topped out near **700**. Which process was busy (Node, Redis, or k6) was not recorded.

## Next

Optional: during another 200-user Redis run, note whether `node`, `k6`, or the Redis container is the busy process. That names the 1,900/sec cap. The Postgres and Redis comparison itself is done.
