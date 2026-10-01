# Location write measurements

Naive path: `POST /api/location` upserts one Postgres row per order.

## Setup

| | |
| --- | --- |
| Tool | k6, `server/load/location.js` |
| Load shape | Virtual users loop as fast as the server answers. No fixed rate. |
| Duration | 20 seconds |
| Orders | 1,000 ids (`ord_0` … `ord_999`) |
| Write | One upsert per request. A repeated order overwrites its row. |
| Machine | k6, Node, and Postgres share one Windows laptop. Postgres runs in Docker. |

Finished requests are responses k6 received. In every run below, all of them were HTTP 200.

## Comparison

| Virtual users | Pool | Finished / sec | p(95) | Failures |
| --- | --- | --- | --- | --- |
| 20 | 10 (default) | 724 | 43 ms | 0 |
| 50 | 10 | 733 | 96 ms | 0 |
| 100 | 10 | 696 | 193 ms | 0 |
| 100 | 50 | 725 | 259 ms | 0 |

Twenty seconds at about 700 finished requests per second is about 14,000 responses. The totals stayed in that band because the rate did not rise. More users increased wait time, not throughput.

## What was ruled out

**The connection pool.** With the default pool, Postgres showed about 12 sessions during a check. One was the `psql` session, so the app held about 10, the `pg` default. Raising the pool to 50 (`server/config/db.js`) raised sessions to 52. Throughput stayed near 725/sec, and p(95) got worse (193 ms to 259 ms).

**Node and k6.** During a later 100-user run the API process used about 0% CPU. It was waiting on Postgres. k6 was not saturated. Redis was under 1% CPU and is not on this write path.

**Postgres CPU.** The Postgres container used 32–42% CPU while the test ran, then fell to 0% when it stopped. The database was not out of CPU.

## Bottleneck

Each ping is one transaction. Postgres calls `fsync` on the write-ahead log before it reports success. Across one 100-user run, `pg_stat_wal` counted about 11,500 WAL syncs for about 13,000 upserts: roughly one disk sync per ping.

That run finished 654 requests/sec with p(95) at 214 ms. It was slightly slower than the table above because Postgres was queried for wait events during the test. The sync rate still landed near 600–700 per second, which matches the ceiling in the table.

On this machine the bottleneck is Postgres commit durability. The Docker disk confirms about 700 transaction syncs per second. More concurrency does not raise that number.

## Next

Write the latest point to Redis with the same k6 script and 100 virtual users. Keep this Postgres path so the two rates can be compared. Redis does not `fsync` on every update.
