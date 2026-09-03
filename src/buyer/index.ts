#!/usr/bin/env tsx
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkInvariants, percentile, type RequestResult, type StatusResponse } from './invariants';

type Args = {
  urls: string[];
  mode: 'naive' | 'correct';
  tickets: number;
  requests: number;
  concurrency: number;
  duplicatePercent: number;
  json: boolean;
  out: string | null;
  skipReset: boolean;
  timeoutMs: number;
  label: string;
};

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseArgs(): Args {
  const urlList = arg('--url', arg('--urls', 'http://127.0.0.1:3000'));
  return {
    urls: urlList.split(',').map((u) => u.replace(/\/$/, '')),
    mode: (arg('--mode', 'correct') as 'naive' | 'correct'),
    tickets: Number(arg('--tickets', '100')),
    requests: Number(arg('--requests', '5000')),
    concurrency: Number(arg('--concurrency', '200')),
    duplicatePercent: Number(arg('--duplicates', '10')),
    json: has('--json'),
    out: arg('--out', '') || null,
    skipReset: has('--skip-reset'),
    timeoutMs: Number(arg('--timeout-ms', '30000')),
    label: arg('--label', ''),
  };
}

type Job = { userId: string; requestId: string };

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildJobs(requests: number, duplicatePercent: number): Job[] {
  const unique: Job[] = Array.from({ length: requests }, (_, i) => ({
    userId: `user-${i}`,
    requestId: `req-${i}`,
  }));
  const extra = Math.round((requests * duplicatePercent) / 100);
  const dupes: Job[] = Array.from({ length: extra }, (_, i) => {
    const src = unique[i % unique.length];
    return { userId: `${src.userId}-replay`, requestId: src.requestId };
  });
  return shuffle([...unique, ...dupes]);
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseServerTiming(header: string | null): number | null {
  if (!header) return null;
  const m = header.match(/dur=([0-9.]+)/);
  return m ? Number(m[1]) : null;
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function resetAll(urls: string[], tickets: number, mode: Args['mode']): Promise<void> {
  for (const url of urls) {
    const res = await postJson(`${url}/reset`, { ticketCount: tickets, mode }, 15_000);
    if (!res.ok) {
      throw new Error(`reset ${url} failed: ${res.status} ${await res.text()}`);
    }
  }
}

export type RunReport = {
  label: string;
  at: string;
  targets: string[];
  mode: string;
  tickets: number;
  uniqueRequests: number;
  duplicateReplays: number;
  totalHttpCalls: number;
  concurrency: number;
  durationMs: number;
  requestsPerSecond: number;
  latencyMs: { p50: number; p99: number; max: number };
  serverTimingMs: { p50: number; p99: number } | null;
  http: { bought: number; soldOut: number; errors: number; byInstance: Record<string, number> };
  invariants: ReturnType<typeof checkInvariants>;
  passed: boolean;
  statusSold: number;
  statusTotal: number;
};

export async function runBuyer(args: Args): Promise<RunReport> {
  if (!args.skipReset) {
    await resetAll(args.urls, args.tickets, args.mode);
  }

  const jobs = buildJobs(args.requests, args.duplicatePercent);
  const wallStart = performance.now();

  const results = await mapPool(jobs, args.concurrency, async (job, index): Promise<RequestResult> => {
    const url = args.urls[index % args.urls.length];
    const t0 = performance.now();
    try {
      const res = await postJson(`${url}/buy`, { userId: job.userId, requestId: job.requestId }, args.timeoutMs);
      const latencyMs = performance.now() - t0;
      const body = (await res.json()) as RequestResult['body'];
      return {
        userId: job.userId,
        requestId: job.requestId,
        latencyMs,
        httpStatus: res.status,
        instanceId: res.headers.get('x-instance-id'),
        serverTimingMs: parseServerTiming(res.headers.get('server-timing')),
        body,
      };
    } catch (err) {
      return {
        userId: job.userId,
        requestId: job.requestId,
        latencyMs: performance.now() - t0,
        httpStatus: 0,
        instanceId: null,
        serverTimingMs: null,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  const durationMs = performance.now() - wallStart;

  const statusUrl = args.urls[0];
  const statusRes = await fetch(`${statusUrl}/status`);
  const status = (await statusRes.json()) as StatusResponse;

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const serverTimings = results
    .map((r) => r.serverTimingMs)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);

  const bought = results.filter((r) => 'status' in r.body && r.body.status === 'ok').length;
  const soldOut = results.filter((r) => 'status' in r.body && r.body.status === 'sold_out').length;
  const errors = results.filter((r) => 'error' in r.body).length;

  const byInstance: Record<string, number> = {};
  for (const r of results) {
    const key = r.instanceId ?? 'unknown';
    byInstance[key] = (byInstance[key] ?? 0) + 1;
  }

  const invariants = checkInvariants(args.tickets, results, status);
  const passed = invariants.every((i) => i.pass);

  return {
    label: args.label,
    at: new Date().toISOString(),
    targets: args.urls,
    mode: args.mode,
    tickets: args.tickets,
    uniqueRequests: args.requests,
    duplicateReplays: jobs.length - args.requests,
    totalHttpCalls: jobs.length,
    concurrency: args.concurrency,
    durationMs,
    requestsPerSecond: jobs.length / (durationMs / 1000),
    latencyMs: {
      p50: percentile(latencies, 50),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
    },
    serverTimingMs:
      serverTimings.length > 0
        ? { p50: percentile(serverTimings, 50), p99: percentile(serverTimings, 99) }
        : null,
    http: { bought, soldOut, errors, byInstance },
    invariants,
    passed,
    statusSold: status.sold,
    statusTotal: status.totalTickets,
  };
}

function printReport(report: RunReport): void {
  const banner = report.passed ? 'PASS' : 'FAIL';
  console.log('');
  console.log(`=== Ticket Stampede buyer ${banner}${report.label ? ` — ${report.label}` : ''} ===`);
  console.log(`targets:       ${report.targets.join(', ')}`);
  console.log(`mode:          ${report.mode}`);
  console.log(`inventory:     ${report.tickets} tickets`);
  console.log(
    `load:          ${report.uniqueRequests} unique buys + ${report.duplicateReplays} replays = ${report.totalHttpCalls} HTTP calls @ concurrency ${report.concurrency}`,
  );
  console.log(`duration:      ${(report.durationMs / 1000).toFixed(3)}s`);
  console.log(`throughput:    ${report.requestsPerSecond.toFixed(0)} req/s`);
  console.log(
    `latency:       p50=${report.latencyMs.p50.toFixed(1)}ms  p99=${report.latencyMs.p99.toFixed(1)}ms  max=${report.latencyMs.max.toFixed(1)}ms`,
  );
  if (report.serverTimingMs) {
    console.log(
      `server-timing: p50=${report.serverTimingMs.p50.toFixed(1)}ms  p99=${report.serverTimingMs.p99.toFixed(1)}ms`,
    );
  }
  console.log(
    `responses:     bought=${report.http.bought}  sold_out=${report.http.soldOut}  errors=${report.http.errors}`,
  );
  console.log(`instances:     ${JSON.stringify(report.http.byInstance)}`);
  console.log(`status:        sold=${report.statusSold} / ${report.statusTotal}`);
  console.log('invariants:');
  for (const inv of report.invariants) {
    console.log(`  ${inv.pass ? 'PASS' : 'FAIL'}  ${inv.name}`);
    console.log(`         ${inv.detail}`);
  }
  console.log('');
}

async function main() {
  const args = parseArgs();
  const report = await runBuyer(args);
  printReport(report);

  const payload = JSON.stringify(report, null, 2);
  if (args.json) {
    console.log(payload);
  }
  if (args.out) {
    const dir = dirname(args.out);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(args.out, payload);
    console.log(`wrote ${args.out}`);
  }

  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
