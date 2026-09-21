import { Injectable } from '@nestjs/common';
import { TicketsService } from '../tickets/tickets.service';
import { ScannerDto } from './dto/scanner.dto';
import { ReceiptsService } from 'src/receipts/receipts.service';
import { DataSource } from 'typeorm';

@Injectable()
export class ScannerService {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly receiptsService: ReceiptsService,
    private readonly dataSource: DataSource,
  ) {}

  async start(dto?: ScannerDto) {
    const barCode = dto?.barCode?.trim();
    if (!barCode) return { success: false, message: 'Ingresá un código de barras.' };
    // Un código físico registrado tiene prioridad incluso si contiene sólo números.
    const ticket = await this.ticketsService.findTicketByCode(barCode);
    if (ticket) {
      const { registration, requiresClose } = await this.ticketsService.createRegistration(ticket.id);
      return { success: true, type: 'TICKET', registrationId: registration.id, requiresClose,
        message: requiresClose ? 'Confirmá el cobro para registrar la salida.' : 'Entrada registrada.' };
    }
    if (/^\d{11,15}$/.test(barCode)) {
      const receipt = await this.receiptsService.getBarcodeReceipt(barCode, this.dataSource.manager);
      if (receipt) return { success: true, type: 'RECEIPT', id: receipt.customer.id, barcode: receipt.barcode, receipt, receiptId: receipt.id };
    }
    return { success: false, message: 'No se encontró un ticket o recibo con ese código.' };
  }
}
