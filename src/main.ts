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
  await app.listen(port, '0.0.0.0');
  logger.log(`Application is running on port ${port}`);
}
bootstrap();
