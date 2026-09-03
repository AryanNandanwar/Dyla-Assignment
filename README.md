# Ticket Stampede

Fifty thousand people want a hundred tickets, and they all arrive in the same sixty seconds.

This repo is a NestJS + PostgreSQL seller, a load-generating buyer, and a write-up of what actually happens under that load. Docker Compose runs three seller replicas behind nginx; the same code runs against local Postgres.

## What the problem is actually asking

It is not a CRUD exercise. It is four invariants under contention:

1. **Capacity** — never sell more tickets than exist.
2. **Uniqueness** — never issue the same ticket number twice.
3. **Idempotency** — if the same `requestId` is retried (timeout, double-click, proxy retry), the buyer gets *one* ticket, not two.
4. **Accountability** — `GET /status` reports a sold count that matches the tickets actually issued.

A `/buy` that is correct on one request and wrong at 5,000 concurrent requests is wrong. Speed only counts after those four hold.

The "naive version first" requirement is there because a buyer that cannot break a lockless check-then-act is not generating real contention. The extra credit (three instances, killed datastore, waitlist, distributed buyer) exists because the single-process mutex people reach for does not survive a second replica.

## Why NestJS + Postgres

| Choice | Reason |
| --- | --- |
| **PostgreSQL** | The lock has to live *outside* the Node process. Row locks, `FOR UPDATE SKIP LOCKED`, and a partial unique index on `(sale_id, request_id)` are the concurrency control. Three Nest instances with no app-level mutex still serialize on the same rows. |
| **NestJS** | Thin HTTP layer: validation, three endpoints, one transaction. The interesting code is SQL, not decorators. |
| **Docker Compose** | Postgres + three sellers + nginx, so the multi-instance case is one command. |

Redis `INCR` can do a fast counter but is a weaker source of truth for "this request id owns ticket 17" once you care about crash recovery. An in-memory mutex is faster still and is also how you oversell the moment a second process starts.

## Schema

```sql
sales (id, total_tickets, mode, created_at)

tickets (
  sale_id,          -- FK, part of PK
  ticket_number,    -- PK with sale_id: uniqueness invariant
  user_id,          -- NULL until claimed
  request_id,       -- NULL until claimed
  purchased_at
)

-- A request id owns at most one ticket in a sale.
CREATE UNIQUE INDEX tickets_sale_request_uidx
  ON tickets (sale_id, request_id)
  WHERE request_id IS NOT NULL;

current_sale (lock, sale_id)              -- singleton pointer every replica reads
faults (lock, db_delay_ms, until_ts)      -- shared slow-DB switch
```

`POST /reset` with `mode=correct` pre-inserts `total_tickets` unsold rows. Claiming is an `UPDATE`, not "read `max(ticket_number)+1` then insert". Computing the next number is the race.

Full DDL: `src/seller/db/schema.sql`.

## APIs

### `POST /reset`

```json
{ "ticketCount": 100, "mode": "naive" | "correct" }
```

Wipes the active sale. `naive` uses in-process memory with no mutex. `correct` uses Postgres.

### `POST /buy`

```json
{ "userId": "user-1", "requestId": "req-1" }
```

| HTTP | Body | Meaning |
| --- | --- | --- |
| 200/201 | `{ "status": "ok", "ticketNumber": 17, "userId", "requestId", "replay" }` | Ticket issued, or the same ticket returned for a retry |
| 409 | `{ "status": "sold_out" }` | Nothing left |
| 503 | `{ "status": "unavailable" }` | Datastore is down; nothing was committed |

`replay: true` means this `requestId` already owned a ticket.

### `GET /status`

```json
{
  "saleId": "...",
  "mode": "correct",
  "totalTickets": 100,
  "sold": 100,
  "tickets": [{ "ticketNumber": 1, "userId": "user-1", "requestId": "req-1" }]
}
```

### Extra (experiments, not in the spec)

- `GET /health` — liveness + `instanceId` so you can see requests land on different replicas.
- `POST /faults` `{ "dbDelayMs": 200, "durationSeconds": 10 }` — every replica runs `pg_sleep` before opening a buy transaction.

## How a ticket is claimed (correct path)

```sql
BEGIN;

-- 1. Idempotency: already owned?
SELECT ticket_number FROM tickets
 WHERE sale_id = $1 AND request_id = $2;

-- 2. Claim one unsold row. SKIP LOCKED lets other replicas proceed
--    on different ticket numbers instead of queueing on one row.
WITH picked AS (
  SELECT ticket_number FROM tickets
   WHERE sale_id = $1 AND user_id IS NULL
   ORDER BY ticket_number
   FOR UPDATE SKIP LOCKED
   LIMIT 1
)
UPDATE tickets t
   SET user_id = $2, request_id = $3, purchased_at = NOW()
  FROM picked
 WHERE t.sale_id = $1 AND t.ticket_number = picked.ticket_number
 RETURNING *;

COMMIT;
```

If two retries of the same `requestId` both pass step 1 and try to claim two different rows, the partial unique index fires (`23505`). The loser rolls back (that ticket returns to the pool) and reads the winner's row.

That is why this works with **three seller processes and no application lock**: the lock is the row in Postgres.

## Why the naive path oversells

Node is single-threaded. A synchronous `sold += 1` is accidentally atomic. The naive inventory therefore **yields** between the capacity check and the write:

```ts
if (this.tickets.length >= this.totalTickets) return 'sold_out';
await setTimeout(5);                 // other requests interleave here
this.tickets.push({ ticketNumber: this.tickets.length + 1, ... });
```

Hundreds of in-flight requests all observe `length < 100`, all pass, all push. Duplicate `requestId`s both win. Across three naive replicas it is worse: each process has its own counter, so ticket number 1 is issued three times.

## Run it

### Local

Postgres 16 on `127.0.0.1:5432`, database/user/password `tickets`.

```bash
npm install
npm run seller                 # :3000
npm run buyer -- --mode naive --tickets 100 --requests 3000 --concurrency 300 --duplicates 15
npm run buyer -- --mode correct --tickets 100 --requests 5000 --concurrency 400 --duplicates 15
```

Full recorded run (naive fail, correct pass, sweep, slow DB, three instances):

```bash
npm run demo
npm run chaos                  # kill Postgres mid-sale and bring it back
```

Reports land in `runs/*.json`.

### Docker (three replicas + nginx)

```bash
docker compose up --build
npm run buyer -- --url http://127.0.0.1:8080 --mode correct --requests 8000 --concurrency 450 --duplicates 20
```

## Buyer

```
tsx src/buyer/index.ts \
  --url http://127.0.0.1:3000 \
  --mode correct \
  --tickets 100 \
  --requests 5000 \
  --concurrency 400 \
  --duplicates 15 \
  --out runs/correct.json
```

`--url` accepts a comma-separated list; requests round-robin. That is the load balancer when Docker is not in the picture.

It prints req/s, p50, p99, and PASS/FAIL on each invariant.

## Recorded runs

From `npm run demo`, a 50k stampede, and `npm run chaos` on this machine.

### 1. Naive — the buyer catches the oversell

`runs/01-naive.json` — 3,000 unique buys + 450 replays, concurrency 300, 100 tickets.

| | |
| --- | --- |
| Result | **FAIL** |
| Throughput | 2,526 req/s |
| p50 / p99 | 104 ms / 300 ms |
| `status.sold` | **176 / 100** |
| Idempotency | 1 request id received two distinct ticket numbers |

Invariant 1 fails (oversold). Invariant 3 fails (one `requestId` mapped to two seats). Invariant 4 fails (`sold=176` vs 175 unique request ids). Ticket numbers on a single process happened to stay unique (`length + 1` after the yield still counts up); they do **not** stay unique once a second process starts — see run 5.

### 2. Correct — four invariants hold

`runs/02-correct.json` — 5,000 unique buys + 750 replays, concurrency 400.

| | |
| --- | --- |
| Result | **PASS** |
| Throughput | 2,757 req/s |
| p50 / p99 | 118 ms / 335 ms |
| `status.sold` | **100 / 100** |
| Winning request ids | 100 |
| Unique ticket numbers | 100 |

Same buyer, same shape of load. The only change is `mode=correct`.

50,000 unique buyers + 5,000 replays (the actual stampede size) also **PASS**: 55,000 HTTP calls in 16.9s at 3,246 req/s, sold exactly 100, zero errors (`runs/07-stampede-50k.json`).

### 3. Where latency degrades — and how we know

`runs/03-sweep-summary.json` — 4,000 buys, 100 tickets, concurrency 50 → 800. Every row **PASS**.

| concurrency | req/s | client p50 | client p99 | server p50 | server p99 |
| --- | --- | --- | --- | --- | --- |
| 50 | **4,565** | 10 ms | 26 ms | 7 ms | 14 ms |
| 100 | 4,288 | 23 ms | 47 ms | 19 ms | 28 ms |
| 200 | 4,345 | 44 ms | 88 ms | 40 ms | 51 ms |
| 400 | 4,232 | 90 ms | 141 ms | 85 ms | 102 ms |
| 800 | 4,076 | 176 ms | 364 ms | 167 ms | 202 ms |

Throughput is already capped at ~4.1–4.5k req/s by concurrency 50. Raising concurrency does not buy RPS; it only queues. Client p50 and `Server-Timing` p50 move together, so the time is spent inside the seller (Postgres checkout + the sold-out `SKIP LOCKED` query), not on the wire.

The pool is 20 connections (`PG_POOL_MAX`). At concurrency 800, ~780 requests wait for a client. That is the p99.

Two buyer processes in parallel (`runs/02b-distributed-buyer.json`) combined for 4,119 req/s — the same ceiling as one buyer at concurrency 50. Adding a second client does not raise throughput. The seller / Postgres is the limit, not the load generator.

### 4. Datastore slow for ten seconds

`POST /faults` `{ "dbDelayMs": 200, "durationSeconds": 10 }` runs `SELECT pg_sleep(0.2)` on every buy *before* `BEGIN`, so connections are held but ticket rows are not locked.

`runs/04-slow-db.json`:

| | |
| --- | --- |
| Result | **PASS** (still exactly 100 sold) |
| Throughput | 209 req/s (down from ~4,000) |
| p99 | 1,023 ms |
| Duration | 10.5 s for 2,200 calls |

Ceiling during the fault is roughly `pool_size / 0.2s` ≈ 100 req/s, plus queueing. After the 10s window, the remaining requests are fast, which is why p50 is 49 ms while p99 is a full second. Slow is not incorrect.

### 5. Three instances, no application lock

Buyer round-robins `:3001,:3002,:3003`. Responses carry `X-Instance-Id`.

Correct (`runs/05-three-instances.json`): **PASS**. 9,600 calls, sold 100/100. Traffic split exactly 3,200 / 3,200 / 3,200 across the three pids. Postgres is the lock.

Naive on the same topology (`runs/05-three-instances-naive.json`): **FAIL**. Client saw **336 winning request ids** for a 100-ticket sale. 115 ticket numbers were handed to multiple request ids (each process issued its own 1, 2, 3, …). `/status` on one replica reported 116 — it cannot see the other processes' memory. This is why an in-process mutex is not an answer.

### 6. Kill Postgres in the middle of a sale

`npm run chaos` → `runs/06-kill-postgres.json`.

1. Sell 25 tickets and confirm them to buyers.
2. `sudo service postgresql stop`.
3. Fire 40 more `/buy`s.
4. Start Postgres again.
5. Finish the sale.

| | |
| --- | --- |
| Result | **PASS** |
| Confirmed before kill | 25 |
| Buys while down | 40 errors, **0 tickets issued** |
| Immediately after restore | still 25, all 25 `requestId`s present |
| After draining the rest of the sale | **100 / 100**, unique numbers, unique request ids |

The seller process stays up (idle `pg` clients emit `error`; we log and drop them instead of crashing). In-flight requests get 503. Committed rows survive. Uncommitted work rolls back. A replay of a confirmed `requestId` after restore returns the original ticket, not a new one.

## Take it further

**Solved: three instances behind a balancer, no application lock.** Postgres row locks + unique index. Different problem from a mutex in one process, and the one this stack is for.

**Solved: kill the datastore mid-sale.** Confirmed tickets survive; nothing is issued while Postgres is down; the sale finishes at 100.

**Solved: prove the client is not the bottleneck.** Sweep RPS is flat from concurrency 50; a second buyer process does not raise combined RPS.

**Not built: waitlist / 30s reservation.** That turns a counter into a state machine (`available → reserved → confirmed | expired → available`). The first race is "expire and grant" happening twice. Same `SKIP LOCKED` pattern on a `reserved_until` column, plus a sweeper. It is a product on top of the claim primitive above, not a different locking story.

## Project layout

```
src/seller/          NestJS app (reset, buy, status, faults)
src/seller/db/       schema.sql + pg pool
src/seller/naive-inventory.ts
src/buyer/           load client + invariant checks
scripts/demo.ts      naive → correct → sweep → slow DB → 3 replicas
scripts/chaos-db.ts  kill Postgres mid-sale
docker-compose.yml   postgres + seller-1/2/3 + nginx :8080
```
