import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { hostname } from 'node:os';
import { PoolClient } from 'pg';
import { DatabaseService } from './db/database.service';
import { NaiveInventory } from './naive-inventory';

export type SellerMode = 'naive' | 'correct';

export type BuyOk = {
  status: 'ok';
  ticketNumber: number;
  userId: string;
  requestId: string;
  replay: boolean;
};

export type BuySoldOut = { status: 'sold_out' };
export type BuyResult = BuyOk | BuySoldOut;

type SaleRow = {
  id: string;
  total_tickets: number;
  mode: SellerMode;
};

type TicketRow = {
  ticket_number: number;
  user_id: string;
  request_id: string;
};

type FaultRow = {
  db_delay_ms: number;
  until_ts: Date | null;
};

@Injectable()
export class TicketsService {
  private readonly naive = new NaiveInventory();
  private mode: SellerMode = 'correct';
  readonly instanceId = `${hostname()}:${process.pid}`;

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async reset(ticketCount: number, mode: SellerMode = 'correct') {
    this.mode = mode;
    this.naive.reset(mode === 'naive' ? ticketCount : 0);

    const sale = await this.db.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const inserted = await client.query<SaleRow>(
          `INSERT INTO sales (total_tickets, mode)
           VALUES ($1, $2)
           RETURNING id, total_tickets, mode`,
          [ticketCount, mode],
        );
        const saleRow = inserted.rows[0];

        if (mode === 'correct') {
          await client.query(
            `INSERT INTO tickets (sale_id, ticket_number)
             SELECT $1, g FROM generate_series(1, $2) AS g`,
            [saleRow.id, ticketCount],
          );
        }

        await client.query(`UPDATE current_sale SET sale_id = $1 WHERE lock = 'X'`, [saleRow.id]);
        await client.query('COMMIT');
        return saleRow;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });

    return {
      saleId: sale.id,
      ticketCount: sale.total_tickets,
      mode: sale.mode,
      instanceId: this.instanceId,
    };
  }

  async buy(userId: string, requestId: string): Promise<BuyResult> {
    try {
      if (this.mode === 'naive') {
        return await this.buyNaive(userId, requestId);
      }
      return await this.buyCorrect(userId, requestId);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (/terminating connection|ECONNREFUSED|Connection terminated|57P01|57P03/i.test(message)) {
        throw new ServiceUnavailableException({ status: 'unavailable', message: 'datastore unavailable' });
      }
      throw err;
    }
  }

  async status() {
    if (this.mode === 'naive') {
      const snap = this.naive.status();
      return {
        saleId: null as string | null,
        mode: 'naive' as const,
        instanceId: this.instanceId,
        totalTickets: snap.totalTickets,
        sold: snap.sold,
        tickets: snap.tickets,
      };
    }

    const sale = await this.activeSale();
    if (!sale) {
      return {
        saleId: null as string | null,
        mode: 'correct' as const,
        instanceId: this.instanceId,
        totalTickets: 0,
        sold: 0,
        tickets: [],
      };
    }

    const tickets = await this.db.query<TicketRow>(
      `SELECT ticket_number, user_id, request_id
       FROM tickets
       WHERE sale_id = $1 AND user_id IS NOT NULL
       ORDER BY ticket_number`,
      [sale.id],
    );

    return {
      saleId: sale.id,
      mode: 'correct' as const,
      instanceId: this.instanceId,
      totalTickets: sale.total_tickets,
      sold: tickets.rows.length,
      tickets: tickets.rows.map((t) => ({
        ticketNumber: t.ticket_number,
        userId: t.user_id,
        requestId: t.request_id,
      })),
    };
  }

  async setFault(dbDelayMs: number, durationSeconds: number) {
    const until =
      durationSeconds === 0 || dbDelayMs === 0
        ? null
        : new Date(Date.now() + durationSeconds * 1000);
    await this.db.query(`UPDATE faults SET db_delay_ms = $1, until_ts = $2 WHERE lock = 'X'`, [
      until ? dbDelayMs : 0,
      until,
    ]);
    return {
      dbDelayMs: until ? dbDelayMs : 0,
      until,
      instanceId: this.instanceId,
    };
  }

  private async buyNaive(userId: string, requestId: string): Promise<BuyResult> {
    const result = await this.naive.buy(userId, requestId);
    if (result === 'sold_out') {
      return { status: 'sold_out' };
    }
    return {
      status: 'ok',
      ticketNumber: result.ticketNumber,
      userId: result.userId,
      requestId: result.requestId,
      replay: false,
    };
  }

  private async buyCorrect(userId: string, requestId: string): Promise<BuyResult> {
    return this.db.withClient(async (client) => {
      await this.applyDbDelay(client);
      await client.query('BEGIN');
      let sale: SaleRow | undefined;
      try {
        const saleRes = await client.query<SaleRow>(
          `SELECT s.id, s.total_tickets, s.mode
           FROM current_sale c
           JOIN sales s ON s.id = c.sale_id
           WHERE c.lock = 'X'`,
        );
        sale = saleRes.rows[0];
        if (!sale) {
          await client.query('ROLLBACK');
          throw new BadRequestException('no active sale; POST /reset first');
        }

        const existing = await client.query<TicketRow>(
          `SELECT ticket_number, user_id, request_id
           FROM tickets
           WHERE sale_id = $1 AND request_id = $2`,
          [sale.id, requestId],
        );
        if (existing.rows[0]) {
          await client.query('COMMIT');
          return this.toOk(existing.rows[0], true);
        }

        const claimed = await client.query<TicketRow>(
            `WITH picked AS (
               SELECT ticket_number
               FROM tickets
               WHERE sale_id = $1 AND user_id IS NULL
               ORDER BY ticket_number
               FOR UPDATE SKIP LOCKED
               LIMIT 1
             )
             UPDATE tickets AS t
             SET user_id = $2,
                 request_id = $3,
                 purchased_at = NOW()
             FROM picked
             WHERE t.sale_id = $1
               AND t.ticket_number = picked.ticket_number
             RETURNING t.ticket_number, t.user_id, t.request_id`,
            [sale.id, userId, requestId],
          );

        if (claimed.rows[0]) {
          await client.query('COMMIT');
          return this.toOk(claimed.rows[0], false);
        }

        await client.query('COMMIT');
        return { status: 'sold_out' };
      } catch (err) {
        await client.query('ROLLBACK');
        if (isUniqueViolation(err) && sale) {
          const replay = await client.query<TicketRow>(
            `SELECT ticket_number, user_id, request_id
             FROM tickets
             WHERE sale_id = $1 AND request_id = $2
             ORDER BY purchased_at
             LIMIT 1`,
            [sale.id, requestId],
          );
          if (replay.rows[0]) {
            return this.toOk(replay.rows[0], true);
          }
        }
        throw err;
      }
    });
  }

  private async applyDbDelay(client: PoolClient): Promise<void> {
    const res = await client.query<FaultRow>(`SELECT db_delay_ms, until_ts FROM faults WHERE lock = 'X'`);
    const row = res.rows[0];
    if (!row?.until_ts || row.db_delay_ms <= 0) {
      return;
    }
    if (new Date(row.until_ts).getTime() < Date.now()) {
      return;
    }
    await client.query(`SELECT pg_sleep($1)`, [row.db_delay_ms / 1000]);
  }

  private async activeSale(): Promise<SaleRow | null> {
    const res = await this.db.query<SaleRow>(
      `SELECT s.id, s.total_tickets, s.mode
       FROM current_sale c
       JOIN sales s ON s.id = c.sale_id
       WHERE c.lock = 'X'`,
    );
    return res.rows[0] ?? null;
  }

  private toOk(row: TicketRow, replay: boolean): BuyOk {
    return {
      status: 'ok',
      ticketNumber: row.ticket_number,
      userId: row.user_id,
      requestId: row.request_id,
      replay,
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505';
}
