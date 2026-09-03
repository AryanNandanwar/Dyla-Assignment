# Ticket Stampede

Fifty thousand people want a hundred tickets, and they all arrive in the same sixty seconds.

This repo is a NestJS + PostgreSQL seller, a load-generating buyer, and a write-up of what breaks under that load. Docker Compose runs three seller replicas behind nginx; the same code also runs against a local Postgres for development.

## What the problem is actually asking

It is not a CRUD exercise. It is four invariants under contention:

1. **Capacity** — never sell more tickets than exist.
2. **Uniqueness** — never issue the same ticket number twice.
3. **Idempotency** — if the same `requestId` is retried (client timeout, double-click, load-balancer retry), the buyer gets *one* ticket, not two.
4. **Accountability** — `GET /status` reports a sold count that matches the tickets actually issued.

`/buy` that is correct on a single request and wrong at 5,000 concurrent requests is wrong. Speed only counts after those four hold.

The "naive version first" requirement is there because a buyer that cannot break a lockless check-then-act is not generating real contention. The extra credit (three instances, killed datastore, waitlist, distributed buyer) exists because the single-process mutex that people reach for does not survive a second replica.

## Why NestJS + Postgres

| Choice | Reason |
| --- | --- |
| **PostgreSQL** | The lock has to live *outside* the Node process. Row locks, `FOR UPDATE SKIP LOCKED`, and a partial unique index on `(sale_id, request_id)` are the actual concurrency control. Three Nest instances with no app-level mutex still serialize on the same rows. |
| **NestJS** | Thin HTTP layer: validation, three endpoints, one transaction. The interesting code is SQL, not decorators. |
| **Docker Compose** | Postgres + three sellers + nginx, so the multi-instance case is one command, not a story. |

Redis `INCR` can do a fast counter but is a weaker source of truth for "this request id owns ticket 17" once you care about crash recovery. An in-memory mutex is faster still and is also how you oversell the moment a second process starts.

## Schema

```sql
sales (id, total_tickets, mode, created_at)

tickets (
  sale_id,          -- FK
  ticket_number,    -- PK with sale_id: the uniqueness invariant
  user_id,          -- NULL until claimed
  request_id,       -- NULL until claimed
  purchased_at
)

-- A request id owns at most one ticket in a sale.
CREATE UNIQUE INDEX tickets_sale_request_uidx
  ON tickets (sale_id, request_id)
  WHERE request_id IS NOT NULL;

current_sale (lock, sale_id)   -- singleton pointer every replica reads
faults (lock, db_delay_ms, until_ts)  -- shared slow-DB switch
```

`POST /reset` with `mode=correct` pre-inserts `total_tickets` unsold rows. Claiming is an `UPDATE`, not "read max(ticket_number)+1 then insert". Computing the next number is the race.

## APIs

### `POST /reset`

```json
{ "ticketCount": 100, "mode": "naive" | "correct" }
```

Wipes the active sale. `naive` uses in-process memory (no mutex). `correct` uses Postgres.

### `POST /buy`

```json
{ "userId": "user-1", "requestId": "req-1" }
```

| HTTP | Body | Meaning |
| --- | --- | --- |
| 200 | `{ "status": "ok", "ticketNumber": 17, "userId", "requestId", "replay" }` | Ticket issued, or the same ticket returned for a retry |
| 409 | `{ "status": "sold_out" }` | Nothing left |

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

- `GET /health` — liveness + `instanceId` so you can see the load balancer move.
- `POST /faults` `{ "dbDelayMs": 200, "durationSeconds": 10 }` — every replica sleeps in Postgres (`pg_sleep`) before opening a buy transaction.

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

Hundreds of in-flight requests all observe `length < 100`, all pass, all push. Ticket numbers collide. Duplicate `requestId`s both win. `/status` faithfully reports the mess — invariant 4 holds, 1–3 do not — which is the point: the buyer must catch this.

Across three naive replicas it is worse: each process has its own counter, so you can sell 100 per replica.

## Run it

### Local (this is what the demo uses)

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

Numbers below come from `npm run demo` on this machine. Re-run it; they will move, the pass/fail column should not.

### 1. Naive — buyer catches the oversell

See `runs/01-naive.json`.

Expected: **FAIL**. `status.sold` well above 100, duplicate ticket numbers, duplicate `requestId`s receiving two seats.

### 2. Correct — four invariants hold

See `runs/02-correct.json`.

Expected: **PASS**. Exactly 100 tickets, unique numbers 1–100, replays return the original ticket, `sold === tickets.length`.

### 3. Where latency degrades

See `runs/03-sweep-summary.json`.

The buyer sends 4000 requests at concurrency 50, 100, 200, 400, 800. Compare:

- **Client latency p99** vs **`Server-Timing` p99**. If they move together, time is spent in the seller/Postgres, not on the wire.
- **req/s** as concurrency grows. When RPS flattens while p99 climbs, the pool or Postgres is saturated (`PG_POOL_MAX` defaults to 20).

Two buyer processes in parallel (`runs/02b-distributed-buyer.json`) answer "is my client the bottleneck?": if combined RPS of A+B is not much higher than one buyer, the seller is the limit.

### 4. Datastore slow for ten seconds

`POST /faults` `{ "dbDelayMs": 200, "durationSeconds": 10 }` runs `SELECT pg_sleep(0.2)` on every buy *before* `BEGIN`, so connections are held but ticket rows are not.

Expected: throughput collapses toward `pool_size / 0.2s` (~100 req/s with 20 connections) for ten seconds, then recovers. **No oversell.** Slow is not incorrect.

### 5. Three instances, no app lock

Buyer round-robins `:3001,:3002,:3003`. Each response carries `X-Instance-Id`. You should see all three pids in `byInstance`. Invariants still **PASS**.

The same topology with `--mode naive` **FAILS** — each process sells its own 100.

## Take it further: what we solved vs what we skipped

**Solved: three instances behind a balancer, no application lock.** Postgres row locks + unique index. That is a different problem from `Mutex` in one process, and it is the one this stack is for.

**Skipped on purpose (do one properly):**

- **Waitlist / 30s reservation.** Turns a counter into a state machine (`available → reserved → confirmed | expired → available`). The first race is "expire and grant" happening twice. Same `SKIP LOCKED` pattern on a `reserved_until` column, plus a sweeper. Not wired up here because it is a product on top of the same claim primitive.
- **Kill Postgres mid-sale.** Confirmed (`COMMIT`ted) rows survive. In-flight requests error. After the database is back, node-pg opens new connections and `/status` still matches committed tickets. The unique index still prevents a replay from taking a second seat. Worth a manual `sudo service postgresql restart` during a run; the demo does not depend on it.
- **Distributed buyer as separate machines.** Two concurrent buyer processes in the demo are the same proof: if adding a second client does not raise RPS, you were not client-bound.

## Project layout

```
src/seller/          NestJS app (reset, buy, status, faults)
src/seller/db/       schema.sql + pg pool
src/seller/naive-inventory.ts
src/buyer/           load client + invariant checks
scripts/demo.ts      naive → correct → sweep → slow DB → 3 replicas
docker-compose.yml   postgres + seller-1/2/3 + nginx :8080
```
