import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? 'postgres://tickets:tickets@127.0.0.1:5432/tickets',
      max: Number(process.env.PG_POOL_MAX ?? 20),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    this.pool.on('error', (err) => {
      console.error(`idle postgres client error: ${err.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    const schemaPath = join(__dirname, 'schema.sql');
    const sql = readFileSync(schemaPath, 'utf8');
    await this.pool.query(sql);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async query<T extends object = Record<string, unknown>>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params);
  }

  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let failed = false;
    try {
      return await fn(client);
    } catch (err) {
      failed = true;
      try {
        client.release(true);
      } catch {
        // already dead
      }
      throw err;
    } finally {
      if (!failed) {
        client.release();
      }
    }
  }
}
