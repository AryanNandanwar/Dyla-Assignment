import { Body, Controller, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BuyDto, FaultDto, ResetDto } from './dto';
import { TicketsService } from './tickets.service';

@Controller()
export class TicketsController {
  constructor(@Inject(TicketsService) private readonly tickets: TicketsService) {}

  @Post('reset')
  @HttpCode(200)
  reset(@Body() dto: ResetDto) {
    return this.tickets.reset(dto.ticketCount, dto.mode ?? 'correct');
  }

  @Post('buy')
  async buy(@Body() dto: BuyDto, @Res({ passthrough: true }) res: Response) {
    const started = performance.now();
    const result = await this.tickets.buy(dto.userId, dto.requestId);
    const ms = performance.now() - started;
    res.setHeader('Server-Timing', `app;dur=${ms.toFixed(1)}`);
    res.setHeader('X-Instance-Id', this.tickets.instanceId);
    if (result.status === 'sold_out') {
      res.status(409);
    }
    return result;
  }

  @Get('status')
  status() {
    return this.tickets.status();
  }

  @Get('health')
  health() {
    return { ok: true, instanceId: this.tickets.instanceId, pid: process.pid };
  }

  @Post('faults')
  @HttpCode(200)
  faults(@Body() dto: FaultDto) {
    return this.tickets.setFault(dto.dbDelayMs, dto.durationSeconds);
  }
}
