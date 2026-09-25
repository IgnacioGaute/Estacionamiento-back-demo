import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Lo que devuelve MercadoPago en la URL después de que el admin autoriza, reenviado por el panel.
// El ValidationPipe global corre con `forbidNonWhitelisted`, así que cualquier campo de más hace
// fallar el pedido: acá van sólo estos dos.
export class ConectarMercadoPagoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  state: string;
}
