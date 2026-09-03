export type NaiveTicket = {
  ticketNumber: number;
  userId: string;
  requestId: string;
};

/**
 * Classic check-then-act inventory. Node is single-threaded, so a
 * synchronous increment would accidentally be atomic. The await between
 * the capacity check and the push yields the event loop, which is what
 * lets concurrent requests oversell — the same race a lockless DB read
 * plus insert has across connections.
 */
export class NaiveInventory {
  totalTickets = 0;
  tickets: NaiveTicket[] = [];

  reset(ticketCount: number): void {
    this.totalTickets = ticketCount;
    this.tickets = [];
  }

  async buy(userId: string, requestId: string): Promise<NaiveTicket | 'sold_out'> {
    const existing = this.tickets.find((t) => t.requestId === requestId);
    if (existing) {
      return existing;
    }

    if (this.tickets.length >= this.totalTickets) {
      return 'sold_out';
    }

    await new Promise((r) => setTimeout(r, 5));

    const ticketNumber = this.tickets.length + 1;
    const ticket: NaiveTicket = { ticketNumber, userId, requestId };
    this.tickets.push(ticket);
    return ticket;
  }

  status() {
    return {
      totalTickets: this.totalTickets,
      sold: this.tickets.length,
      tickets: this.tickets.map((t) => ({
        ticketNumber: t.ticketNumber,
        userId: t.userId,
        requestId: t.requestId,
      })),
    };
  }
}
