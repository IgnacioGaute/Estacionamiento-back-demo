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
import { TipoVehiculoService } from './tipo-vehiculo.service';
import { ImageSignatureValidator } from './image-signature.validator';

const subida = FileInterceptor('image', {
  storage: memoryStorage(),
  // Tope duro de la subida. Plate Recognizer acepta hasta 3 MB y eso lo valida el servicio con
  // un mensaje en castellano; multer respondería «File too large» a secas.
  limits: { fileSize: 6 * 1024 * 1024 },
});

const imagen = () => new ParseFilePipe({
  validators: [new ImageSignatureValidator()],
  fileIsRequired: true,
});

@Controller('plate-recognition')
@UseGuards(AuthOrTokenAuthGuard)
export class PlateRecognitionController {
  constructor(
    private readonly plateRecognitionService: PlateRecognitionService,
    private readonly tipoVehiculo: TipoVehiculoService,
  ) {}

  @Post('scan')
  @UseInterceptors(subida)
  async scan(@UploadedFile(imagen()) file: Express.Multer.File) {
    return this.plateRecognitionService.recognize(file);
  }

  // La foto con la que se leyó la patente: sugiere el tipo y el modelo del vehículo, con Gemini.
  @Post('vehicle-type')
  @UseInterceptors(subida)
  async detectarTipo(@UploadedFile(imagen()) file: Express.Multer.File) {
    return this.tipoVehiculo.detectar(file);
  }
}
