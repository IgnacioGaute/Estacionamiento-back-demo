import { Module } from '@nestjs/common';
import { PlateRecognitionController } from './plate-recognition.controller';
import { PlateRecognitionService } from './plate-recognition.service';

@Module({
  controllers: [PlateRecognitionController],
  providers: [PlateRecognitionService],
})
export class PlateRecognitionModule {}
