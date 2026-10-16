import { IsInt, Max, Min } from 'class-validator';

// La parte en efectivo de un pago híbrido cuyo resto va por QR o alias (ver cobrarParteEnEfectivo).
export class PagoParcialDto {
  @IsInt({ message: 'Los importes van en pesos enteros, sin centavos.' }) @Min(1) @Max(1_000_000_000) importe: number;
  @IsInt() @Min(0) expectedPrice: number;
  @IsInt() @Min(0) expectedCollected: number;
}
