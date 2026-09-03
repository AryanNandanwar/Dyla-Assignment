export type BuyResponse =
  | { status: 'ok'; ticketNumber: number; userId: string; requestId: string; replay?: boolean }
  | { status: 'sold_out' };

export type StatusResponse = {
  saleId: string | null;
  mode: 'naive' | 'correct';
  instanceId: string;
  totalTickets: number;
  sold: number;
  tickets: Array<{ ticketNumber: number; userId: string; requestId: string }>;
};

export type RequestResult = {
  userId: string;
  requestId: string;
  latencyMs: number;
  httpStatus: number;
  instanceId: string | null;
  serverTimingMs: number | null;
  body: BuyResponse | { error: string };
};

export type InvariantResult = {
  id: 'no_oversell' | 'unique_ticket_numbers' | 'idempotent_request_ids' | 'status_matches_issued';
  name: string;
  pass: boolean;
  detail: string;
};

export function checkInvariants(
  totalTickets: number,
  results: RequestResult[],
  status: StatusResponse,
): InvariantResult[] {
  const okBodies = results
    .map((r) => r.body)
    .filter((b): b is Extract<BuyResponse, { status: 'ok' }> => 'status' in b && b.status === 'ok');

  const requestIdsWithTicket = new Map<string, Set<number>>();
  const issuedByNumber = new Map<number, Set<string>>();
  for (const body of okBodies) {
    const nums = requestIdsWithTicket.get(body.requestId) ?? new Set<number>();
    nums.add(body.ticketNumber);
    requestIdsWithTicket.set(body.requestId, nums);

    const ids = issuedByNumber.get(body.ticketNumber) ?? new Set<string>();
    ids.add(body.requestId);
    issuedByNumber.set(body.ticketNumber, ids);
  }

  const winningRequestIds = requestIdsWithTicket.size;
  const splitRequestIds = [...requestIdsWithTicket.entries()].filter(([, nums]) => nums.size > 1);
  const sharedNumbers = [...issuedByNumber.entries()].filter(([, ids]) => ids.size > 1);

  const statusNumbers = status.tickets.map((t) => t.ticketNumber);
  const uniqueStatusNumbers = new Set(statusNumbers);
  const statusRequestIds = status.tickets.map((t) => t.requestId);
  const uniqueStatusRequestIds = new Set(statusRequestIds);

  const noOversellPass =
    status.sold <= totalTickets &&
    winningRequestIds <= totalTickets &&
    uniqueStatusNumbers.size <= totalTickets;
  const uniqueNumbersPass = statusNumbers.length === uniqueStatusNumbers.size && sharedNumbers.length === 0;
  const idempotentPass = splitRequestIds.length === 0 && statusRequestIds.length === uniqueStatusRequestIds.size;
  const statusMatchesPass =
    status.sold === status.tickets.length &&
    status.sold === uniqueStatusNumbers.size &&
    status.sold === uniqueStatusRequestIds.size &&
    status.sold === winningRequestIds;

  return [
    {
      id: 'no_oversell',
      name: 'Never sell more tickets than exist',
      pass: noOversellPass,
      detail: `status.sold=${status.sold} total=${totalTickets} clientWinningIds=${winningRequestIds} uniqueNumbers=${uniqueStatusNumbers.size}`,
    },
    {
      id: 'unique_ticket_numbers',
      name: 'Never issue the same ticket number twice',
      pass: uniqueNumbersPass,
      detail: uniqueNumbersPass
        ? `all ${statusNumbers.length} ticket numbers are unique`
        : `status rows=${statusNumbers.length} unique=${uniqueStatusNumbers.size}; ${sharedNumbers.length} numbers handed to multiple request ids`,
    },
    {
      id: 'idempotent_request_ids',
      name: 'Same request id yields one ticket, not two',
      pass: idempotentPass,
      detail: idempotentPass
        ? `no request id mapped to multiple ticket numbers (client saw ${requestIdsWithTicket.size} winning ids)`
        : `${splitRequestIds.length} request ids received distinct ticket numbers; status request ids ${statusRequestIds.length} vs unique ${uniqueStatusRequestIds.size}`,
    },
    {
      id: 'status_matches_issued',
      name: '/status count matches tickets actually issued',
      pass: statusMatchesPass,
      detail: `sold=${status.sold} tickets.length=${status.tickets.length} uniqueNumbers=${uniqueStatusNumbers.size} uniqueRequestIds=${uniqueStatusRequestIds.size} clientWinningIds=${winningRequestIds}`,
    },
  ];
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}
