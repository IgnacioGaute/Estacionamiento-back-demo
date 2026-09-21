import { Module } from '@nestjs/common';
import { TurnosModule } from '../turnos/turnos.module';
import { TicketsModule } from '../tickets/tickets.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
@Module({ imports: [TurnosModule, TicketsModule], controllers: [AssistantController], providers: [AssistantService] })
export class AssistantModule {}
