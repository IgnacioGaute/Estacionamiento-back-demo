import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { AssistantService } from './assistant.service';
export class AssistantMessageDto {
  @IsString() @MinLength(1) @MaxLength(1500) message: string;
  @IsOptional() @IsString() @MaxLength(160) screen?: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsString() @MaxLength(8000) screenContext?: string;
}
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post('chat') @HttpCode(200) chat(@Body() dto: AssistantMessageDto) { return this.assistant.chat(dto); }

  /**
   * Misma consulta, pero devolviendo el texto a medida que Gemini lo genera. El
   * front puede seguir usando /assistant/chat: este endpoint es adicional, así
   * que si el streaming falla el asistente sigue funcionando como antes.
   */
  @Post('chat/stream') @HttpCode(200)
  async stream(@Body() dto: AssistantMessageDto, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Sin esto, un proxy con buffer junta todos los pedazos y se pierde el efecto.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const enviar = (evento: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(evento)}\n\n`);
    };

    try {
      const resultado = await this.assistant.chat(dto, enviar);
      enviar({ fin: true, ...resultado });
    } catch (error: any) {
      // Ya se enviaron las cabeceras: el error viaja como un evento más, no como
      // un status HTTP, que a esta altura el navegador ya no puede leer.
      const mensaje = error?.response?.message ?? error?.message;
      enviar({ error: typeof mensaje === 'string' ? mensaje : 'No se pudo consultar el asistente.' });
    } finally {
      res.end();
    }
  }
}
