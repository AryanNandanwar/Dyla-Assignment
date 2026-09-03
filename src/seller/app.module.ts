import { Module } from '@nestjs/common';
import { DatabaseService } from './db/database.service';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  controllers: [TicketsController],
  providers: [DatabaseService, TicketsService],
})
export class AppModule {}
