import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class ResetDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  ticketCount!: number;

  @IsOptional()
  @IsIn(['naive', 'correct'])
  mode?: 'naive' | 'correct';
}

export class BuyDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  requestId!: string;
}

export class FaultDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60_000)
  dbDelayMs!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  durationSeconds!: number;
}
