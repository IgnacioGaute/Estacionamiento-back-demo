import { Injectable } from '@nestjs/common';
import { TicketsService } from '../tickets/tickets.service';
import { ScannerDto } from './dto/scanner.dto';
import { ReceiptsService } from 'src/receipts/receipts.service';
import { DataSource } from 'typeorm';
import { esGratuita } from 'src/tenancy/modalidad';
import { tenantContext } from 'src/tenancy/tenant-context';

@Injectable()
export class ScannerService {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly receiptsService: ReceiptsService,
    private readonly dataSource: DataSource,
  ) {}

  async start(dto?: ScannerDto, userId?: string) {
    const barCode = dto?.barCode?.trim();
    if (!barCode) return { success: false, message: 'Ingresá un código de barras.' };
    // Un código físico registrado tiene prioridad incluso si contiene sólo números.
    const ticket = await this.ticketsService.findTicketByCode(barCode);
    if (ticket) {
      const { registration, requiresClose } = await this.ticketsService.createRegistration(ticket.id, userId);
      const gratuita = esGratuita(registration.modalidad);
      return { success: true, type: 'TICKET', registrationId: registration.id, requiresClose, modalidad: registration.modalidad,
        message: requiresClose ? (gratuita ? 'Confirmá la salida.' : 'Confirmá el cobro para registrar la salida.') : 'Entrada registrada.' };
    }
    // Los recibos de clientes mensuales son facturación: una playa gratuita no los cobra.
    if (/^\d{11,15}$/.test(barCode) && !esGratuita(tenantContext.getStore()?.modalidad)) {
      const receipt = await this.receiptsService.getBarcodeReceipt(barCode, this.dataSource.manager);
      if (receipt) return { success: true, type: 'RECEIPT', id: receipt.customer.id, barcode: receipt.barcode, receipt, receiptId: receipt.id };
    }
    return { success: false, message: 'No se encontró un ticket o recibo con ese código.' };
  }
}
