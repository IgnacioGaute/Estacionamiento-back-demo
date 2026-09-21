import {
  Controller,
  ParseFilePipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { PlateRecognitionService } from './plate-recognition.service';
import { ImageSignatureValidator } from './image-signature.validator';

@Controller('plate-recognition')
@UseGuards(AuthOrTokenAuthGuard)
export class PlateRecognitionController {
  constructor(private readonly plateRecognitionService: PlateRecognitionService) {}

  @Post('scan')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: 6 * 1024 * 1024 }, // 6MB alcanza de sobra para una foto de celular
    }),
  )
  async scan(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new ImageSignatureValidator()],
        fileIsRequired: true,
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.plateRecognitionService.recognize(file);
  }
}
