#!/usr/bin/env tsx
/**
 * Kill Postgres in the middle of a sale, bring it back, and prove:
 *   - confirmed tickets are still there
 *   - nothing extra was issued while the DB was down
 *   - the sale can finish without overselling
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const URL = 'http://127.0.0.1:3000';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnSeller(): ChildProcess {
  return spawn('npx', ['tsx', 'src/seller/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: '3000',
      DATABASE_URL: 'postgres://tickets:tickets@127.0.0.1:5432/tickets',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

async function waitForHealth(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${URL}/health`);
      if (res.ok) return;
    } catch {
      // down
    }
    await sleep(150);
  }
  throw new Error('seller never became healthy');
}

async function buy(userId: string, requestId: string) {
  try {
    const res = await fetch(`${URL}/buy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, requestId }),
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.json();
    return { http: res.status, body };
  } catch (err) {
    return { http: 0, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

async function status() {
  const res = await fetch(`${URL}/status`);
  return res.json() as Promise<{
    sold: number;
    totalTickets: number;
    tickets: Array<{ ticketNumber: number; userId: string; requestId: string }>;
  }>;
}

async function main() {
  mkdirSync('runs', { recursive: true });
  const seller = spawnSeller();
  seller.stdout?.on('data', (b) => process.stdout.write(`[seller] ${b}`));
  seller.stderr?.on('data', (b) => process.stderr.write(`[seller] ${b}`));

  try {
    await waitForHealth();
    await fetch(`${URL}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketCount: 100, mode: 'correct' }),
    });

    const confirmed: string[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await buy(`pre-${i}`, `pre-${i}`);
      if (r.body && 'status' in r.body && r.body.status === 'ok') {
        confirmed.push(`pre-${i}`);
      }
    }
    const before = await status();
    console.log(`confirmed before kill: ${before.sold} (want 25)`);

    console.log('stopping postgres...');
    execSync('sudo service postgresql stop', { stdio: 'inherit' });
    await sleep(500);

    let errorsWhileDown = 0;
    let surpriseTickets = 0;
    for (let i = 0; i < 40; i++) {
      const r = await buy(`down-${i}`, `down-${i}`);
      if (r.body && 'status' in r.body && r.body.status === 'ok') surpriseTickets++;
      else errorsWhileDown++;
    }
    console.log(`while down: errors=${errorsWhileDown} surpriseTickets=${surpriseTickets}`);

    console.log('starting postgres...');
    execSync('sudo service postgresql start', { stdio: 'inherit' });
    await sleep(1500);

    let after: Awaited<ReturnType<typeof status>> | null = null;
    for (let i = 0; i < 50; i++) {
      try {
        after = await status();
        if (after && typeof after.sold === 'number') break;
      } catch {
        // pool still reconnecting
      }
      await sleep(250);
    }
    if (!after) throw new Error('status never recovered');

    const stillHaveConfirmed = confirmed.every((id) => after!.tickets.some((t) => t.requestId === id));
    console.log(`after restore: sold=${after.sold} confirmedStillPresent=${stillHaveConfirmed}`);

    for (let i = 0; i < 200; i++) {
      await buy(`post-${i}`, `post-${i}`);
    }
    const finalStatus = await status();
    const numbers = finalStatus.tickets.map((t) => t.ticketNumber);
    const unique = new Set(numbers);
    const requestIds = finalStatus.tickets.map((t) => t.requestId);
    const uniqueReq = new Set(requestIds);

    const report = {
      confirmedBeforeKill: before.sold,
      errorsWhileDown,
      surpriseTicketsWhileDown: surpriseTickets,
      soldImmediatelyAfterRestore: after.sold,
      confirmedTicketsSurvived: stillHaveConfirmed,
      finalSold: finalStatus.sold,
      finalTotal: finalStatus.totalTickets,
      uniqueTicketNumbers: unique.size,
      uniqueRequestIds: uniqueReq.size,
      invariants: {
        noOversell: finalStatus.sold <= 100,
        uniqueNumbers: unique.size === finalStatus.sold,
        noLostSale: stillHaveConfirmed && after.sold === before.sold,
        noTicketIssuedWhileDown: surpriseTickets === 0,
        statusMatches: finalStatus.sold === finalStatus.tickets.length && finalStatus.sold === unique.size,
      },
    };
    const passed = Object.values(report.invariants).every(Boolean);
    writeFileSync('runs/06-kill-postgres.json', JSON.stringify({ passed, ...report }, null, 2));
    console.log(JSON.stringify({ passed, ...report }, null, 2));
    process.exit(passed ? 0 : 1);
  } finally {
    if (seller.pid) {
      try {
        process.kill(-seller.pid, 'SIGKILL');
      } catch {
        seller.kill('SIGKILL');
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  try {
    execSync('sudo service postgresql start');
  } catch {
    // already up
  }
  process.exit(1);
});
