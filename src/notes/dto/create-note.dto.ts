import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateNoteDto {

    @IsNotEmpty()
    @IsString()
    @MaxLength(650)
    description: string;

    @IsNotEmpty()
    @IsString()
    @IsOptional()
    date: string | null;

    @IsNotEmpty()
    @IsString()
    @IsOptional()
    hours: string | null;
}
