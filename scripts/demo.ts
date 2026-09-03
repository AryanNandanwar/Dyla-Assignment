#!/usr/bin/env tsx
/**
 * End-to-end demo:
 *   1. Naive seller oversells; buyer fails invariants.
 *   2. Correct seller holds all four invariants.
 *   3. Concurrency sweep to find where latency degrades.
 *   4. Datastore slowed for 10s in the middle of a sale.
 *   5. Three seller processes, no app-level lock, invariants still hold.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runBuyer, type RunReport } from '../src/buyer/index';

const ROOT = process.cwd();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnSeller(port: number): ChildProcess {
  const child = spawn('npx', ['tsx', 'src/seller/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://tickets:tickets@127.0.0.1:5432/tickets',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout?.on('data', (buf) => process.stdout.write(`[seller:${port}] ${buf}`));
  child.stderr?.on('data', (buf) => process.stderr.write(`[seller:${port}] ${buf}`));
  return child;
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`seller at ${url} did not become healthy`);
}

async function waitUntilDown(url: string, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`${url}/health`, { signal: AbortSignal.timeout(400) });
      await sleep(100);
    } catch {
      return;
    }
  }
}

async function stop(child: ChildProcess, port: number): Promise<void> {
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  await waitUntilDown(`http://127.0.0.1:${port}`);
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function save(name: string, report: RunReport) {
  mkdirSync('runs', { recursive: true });
  writeFileSync(`runs/${name}.json`, JSON.stringify(report, null, 2));
  console.log(`saved runs/${name}.json passed=${report.passed}`);
}

async function main() {
  mkdirSync('runs', { recursive: true });
  const reports: Record<string, RunReport> = {};

  // --- 1. Naive single instance ------------------------------------------------
  const naive = spawnSeller(3000);
  try {
    await waitForHealth('http://127.0.0.1:3000');
    const naiveReport = await runBuyer({
      urls: ['http://127.0.0.1:3000'],
      mode: 'naive',
      tickets: 100,
      requests: 3000,
      concurrency: 300,
      duplicatePercent: 15,
      json: false,
      out: null,
      skipReset: false,
      timeoutMs: 30_000,
      label: 'naive single-instance',
    });
    save('01-naive', naiveReport);
    reports.naive = naiveReport;
  } finally {
    await stop(naive, 3000);
    await sleep(300);
  }

  // --- 2. Correct single instance ---------------------------------------------
  const correct = spawnSeller(3000);
  try {
    await waitForHealth('http://127.0.0.1:3000');
    const correctReport = await runBuyer({
      urls: ['http://127.0.0.1:3000'],
      mode: 'correct',
      tickets: 100,
      requests: 5000,
      concurrency: 400,
      duplicatePercent: 15,
      json: false,
      out: null,
      skipReset: false,
      timeoutMs: 30_000,
      label: 'correct single-instance',
    });
    save('02-correct', correctReport);
    reports.correct = correctReport;

    // Two buyer processes in parallel. If combined RPS is far above a single
    // buyer, the client was the bottleneck; if it stays flat, the seller is.
    await fetch('http://127.0.0.1:3000/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketCount: 100, mode: 'correct' }),
    });
    const buyerA = runBuyer({
      urls: ['http://127.0.0.1:3000'],
      mode: 'correct',
      tickets: 100,
      requests: 4000,
      concurrency: 250,
      duplicatePercent: 0,
      json: false,
      out: null,
      skipReset: true,
      timeoutMs: 30_000,
      label: 'parallel-buyer-A',
    });
    const buyerB = runBuyer({
      urls: ['http://127.0.0.1:3000'],
      mode: 'correct',
      tickets: 100,
      requests: 4000,
      concurrency: 250,
      duplicatePercent: 0,
      json: false,
      out: null,
      skipReset: true,
      timeoutMs: 30_000,
      label: 'parallel-buyer-B',
    });
    const [a, b] = await Promise.all([buyerA, buyerB]);
    save('02b-buyer-A', a);
    save('02b-buyer-B', b);
    const combinedRps = a.requestsPerSecond + b.requestsPerSecond;
    writeFileSync(
      'runs/02b-distributed-buyer.json',
      JSON.stringify(
        {
          singleBuyerRps: Math.round(correctReport.requestsPerSecond),
          singleBuyerConcurrency: correctReport.concurrency,
          parallelBuyerARps: Math.round(a.requestsPerSecond),
          parallelBuyerBRps: Math.round(b.requestsPerSecond),
          parallelCombinedRps: Math.round(combinedRps),
          note:
            combinedRps > correctReport.requestsPerSecond * 1.3
              ? 'Combined parallel buyers are materially faster — the single client was limiting throughput.'
              : 'Combined parallel buyers do not beat a single client by much — the seller (or shared Postgres) is the limit, not the buyer process.',
        },
        null,
        2,
      ),
    );

    // --- 3. Concurrency sweep -------------------------------------------------
    const sweep: RunReport[] = [];
    for (const concurrency of [50, 100, 200, 400, 800]) {
      const r = await runBuyer({
        urls: ['http://127.0.0.1:3000'],
        mode: 'correct',
        tickets: 100,
        requests: 4000,
        concurrency,
        duplicatePercent: 0,
        json: false,
        out: null,
        skipReset: false,
        timeoutMs: 30_000,
        label: `sweep c=${concurrency}`,
      });
      save(`03-sweep-c${concurrency}`, r);
      sweep.push(r);
    }
    writeFileSync(
      'runs/03-sweep-summary.json',
      JSON.stringify(
        sweep.map((r) => ({
          concurrency: r.concurrency,
          rps: Math.round(r.requestsPerSecond),
          p50: Number(r.latencyMs.p50.toFixed(1)),
          p99: Number(r.latencyMs.p99.toFixed(1)),
          serverP50: r.serverTimingMs?.p50,
          serverP99: r.serverTimingMs?.p99,
          passed: r.passed,
        })),
        null,
        2,
      ),
    );

    // --- 4. Slow datastore for 10 seconds -------------------------------------
    await fetch('http://127.0.0.1:3000/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketCount: 100, mode: 'correct' }),
    });
    await fetch('http://127.0.0.1:3000/faults', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dbDelayMs: 200, durationSeconds: 10 }),
    });
    const slow = await runBuyer({
      urls: ['http://127.0.0.1:3000'],
      mode: 'correct',
      tickets: 100,
      requests: 2000,
      concurrency: 100,
      duplicatePercent: 10,
      json: false,
      out: null,
      skipReset: true,
      timeoutMs: 60_000,
      label: 'slow datastore (pg_sleep 200ms for 10s)',
    });
    save('04-slow-db', slow);
    reports.slow = slow;
  } finally {
    await stop(correct, 3000);
    await sleep(300);
  }

  // --- 5. Three instances, no application lock --------------------------------
  const s1 = spawnSeller(3001);
  const s2 = spawnSeller(3002);
  const s3 = spawnSeller(3003);
  try {
    await waitForHealth('http://127.0.0.1:3001');
    await waitForHealth('http://127.0.0.1:3002');
    await waitForHealth('http://127.0.0.1:3003');
    const multi = await runBuyer({
      urls: ['http://127.0.0.1:3001', 'http://127.0.0.1:3002', 'http://127.0.0.1:3003'],
      mode: 'correct',
      tickets: 100,
      requests: 8000,
      concurrency: 450,
      duplicatePercent: 20,
      json: false,
      out: null,
      skipReset: false,
      timeoutMs: 30_000,
      label: 'three instances, postgres is the lock',
    });
    save('05-three-instances', multi);
    reports.multi = multi;

    const naiveMulti = await runBuyer({
      urls: ['http://127.0.0.1:3001', 'http://127.0.0.1:3002', 'http://127.0.0.1:3003'],
      mode: 'naive',
      tickets: 100,
      requests: 1500,
      concurrency: 300,
      duplicatePercent: 10,
      json: false,
      out: null,
      skipReset: false,
      timeoutMs: 30_000,
      label: 'three instances naive (in-memory per process)',
    });
    save('05-three-instances-naive', naiveMulti);
  } finally {
    await stop(s1, 3001);
    await stop(s2, 3002);
    await stop(s3, 3003);
  }

  console.log('\n==== demo complete ====\n');
  for (const [name, r] of Object.entries(reports)) {
    console.log(`${name}: passed=${r.passed} rps=${r.requestsPerSecond.toFixed(0)} sold=${r.statusSold}/${r.statusTotal}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
