import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class DatabaseExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json(exception.getResponse());
      return;
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    const down =
      /terminating connection|ECONNREFUSED|Connection terminated|connect ECONNREFUSED|57P01|57P02|57P03/i.test(
        message,
      );
    const status = down ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.INTERNAL_SERVER_ERROR;
    if (down) {
      res.status(status).json({ status: 'unavailable', message: 'datastore unavailable' });
      return;
    }
    res.status(status).json({ statusCode: status, message: 'Internal server error' });
  }
}
