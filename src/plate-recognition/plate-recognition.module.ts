import { Module } from '@nestjs/common';
import { PlateRecognitionController } from './plate-recognition.controller';
import { PlateRecognitionService } from './plate-recognition.service';
import { PlateRecognizerCuentasModule } from './plate-recognizer-cuentas.module';

@Module({
  imports: [PlateRecognizerCuentasModule],
  controllers: [PlateRecognitionController],
  providers: [PlateRecognitionService],
})
export class PlateRecognitionModule {}
