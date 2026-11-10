import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { NestExpressApplication } from '@nestjs/platform-express';


async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('NestApplication');
  const configService = app.get(ConfigService);

  app.use(helmet());
  
  app.enableCors({
    origin: configService.getOrThrow('app.allowedOrigins'),
    methods: 'GET,PUT,PATCH,POST,DELETE',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  // Local files must never bypass authentication and tenant authorization.

  const port = configService.get('app.port');
  // La red privada de Railway puede resolver IPv6; :: también admite conexiones IPv4.
  await app.listen(port, '::');
  logger.log(`Application is running on port ${port}`);
}
bootstrap();
