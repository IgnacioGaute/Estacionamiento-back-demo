import { IsNumber, IsOptional, IsString } from "class-validator"

export class CreateBoxListDto {

    @IsString()
    @IsOptional()
    date: string;

    @IsNumber()
    totalPrice: number

    @IsString()
    @IsOptional()
    Registrations?: string[]
}
