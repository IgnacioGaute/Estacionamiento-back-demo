import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { CONDICIONES_IVA, CondicionIva, EMPRESA_ESTADO, EmpresaEstado } from '../entities/empresa.entity';
import { EsCuit, normalizarCuit } from '../cuit';

// Texto opcional: sin espacios de más, y vacío es «sin cargar» (null), así se puede borrar un dato.
const textoOpcional = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class CreateEmpresaDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nombre: string;

  @IsIn(EMPRESA_ESTADO)
  @IsOptional()
  estado?: EmpresaEstado;

  // Días de prueba gratis desde hoy. Es una opción del alta: sin esto (o con 0) la empresa queda
  // sin plan ni vencimiento, y la prueba se le puede dar después desde su ficha.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  diasPrueba?: number;

  // Datos para cobrarle y contactarla. Todos opcionales; null o vacío los borra.
  @Transform(textoOpcional)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  razonSocial?: string | null;

  @Transform(({ value }) => normalizarCuit(textoOpcional({ value })))
  @IsOptional()
  @EsCuit()
  cuit?: string | null;

  @IsOptional()
  @IsIn(CONDICIONES_IVA)
  condicionIva?: CondicionIva | null;

  @Transform(textoOpcional)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contactoNombre?: string | null;

  @Transform(textoOpcional)
  @IsOptional()
  @IsEmail({}, { message: 'El email de contacto no es válido.' })
  @MaxLength(255)
  contactoEmail?: string | null;

  @Transform(textoOpcional)
  @IsOptional()
  @Matches(/^\+?[\d\s()-]{6,30}$/, { message: 'El teléfono solo lleva números, espacios, guiones y un + adelante.' })
  contactoTelefono?: string | null;

  @Transform(textoOpcional)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  ciudad?: string | null;

  @Transform(textoOpcional)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  provincia?: string | null;
}
