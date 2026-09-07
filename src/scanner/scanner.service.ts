import { Injectable, Logger } from '@nestjs/common';
import { TicketsService } from '../tickets/tickets.service';
import { ScannerDto } from './dto/scanner.dto';
import { ReceiptsService } from 'src/receipts/receipts.service';
import { UpdateReceiptDto } from 'src/receipts/dto/update-receipt.dto';
import { Receipt } from 'src/receipts/entities/receipt.entity';
import { DataSource } from 'typeorm';

@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);
  private isScanning = false;

  constructor(
    private readonly ticketsService: TicketsService,
    private readonly receiptsService: ReceiptsService,
    private readonly dataSource: DataSource,
    
  ) {}

  async start(scannerDto?: ScannerDto): Promise<{ success: boolean; message: string; type?: string; id?:string, barcode?: string, receipt?: Receipt, receiptId?: string, warning?: string }> {
    if (this.isScanning) {
      return { success: false, message: 'El escáner ya está en ejecución.' };
    }
  
    this.isScanning = true;
    this.logger.log(`Procesando código de barras: ${scannerDto?.barCode}`);
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
  
    try {
      const barCode = scannerDto?.barCode;
  
      if (!barCode) {
        this.isScanning = false;
        return { success: false, message: 'No se proporcionó un código de barras.' };
      }
  
      // Verifica si el barcode tiene exactamente 11 dígitos numéricos
      const isReceiptCode = /^\d{11,15}$/.test(barCode);
  
      if (!isReceiptCode) {
        const ticket = await this.ticketsService.findTicketByCode(barCode);
  
        if (!ticket) {
          this.logger.warn(`No se encontró un ticket con el código: ${barCode}`);
          this.isScanning = false;
          return { success: false, message: `No se encontró un ticket con el código: ${barCode}` };
        }
  
        const registration = await this.ticketsService.createRegistration(ticket.id);
  
        this.isScanning = false;
        if (registration) {
          this.logger.log('Registro de ticket creado exitosamente.');
          const warnings: string[] = [];
          if (registration.exceededExpectedStay) {
            warnings.push(
              `El cliente había avisado que se quedaba hasta "${registration.expectedBracketLabel}", pero la estadía real fue más larga.`,
            );
          }
          if (registration.priceBracketFallbackUsed) {
            warnings.push(
              `La estadía superó todas las franjas de precio configuradas. Se cobró la tarifa "${registration.priceBracketLabel}". Revisá la configuración en Tarifas.`,
            );
          }
          return {
            success: true,
            message: 'Registro de ticket creado exitosamente.',
            type: 'TICKET',
            warning: warnings.length > 0 ? warnings.join(' ') : undefined,
          };
        } else {
          this.logger.warn('No se pudo registrar el ticket.');
          return { success: false, message: 'No se pudo registrar el ticket.' };
        }
  
      } else {
        const barcodeReceipt = await this.receiptsService.getBarcodeReceipt(barCode, queryRunner.manager);

  
        if (!barcodeReceipt) {
          this.logger.warn(`No se encontró un recibo con el código: ${barCode}`);
          this.isScanning = false;
          return { success: false, message: `No se encontró un recibo con el código: ${barCode}` };
        }
  

        this.isScanning = false;
        await queryRunner.commitTransaction();
        if (barcodeReceipt) {
          this.logger.log('Busqueda del recibo existosa.');
          return {
            success: true,
            message: 'Busqueda del recibo exitosa.',
            type: 'RECEIPT',
            id: barcodeReceipt.customer.id,
            barcode: barcodeReceipt.barcode,
            receipt: barcodeReceipt,
            receiptId: barcodeReceipt.id
          };
          
        } else {
          this.logger.warn('No se pudo encontrar el recibo.');
          return { success: false, message: 'No se pudo encontrar el recibo.' };
        }
      }
    } catch (error: any) {
      this.logger.error('Error al procesar el código de barras:', error);
      this.isScanning = false;
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      return { success: false, message: error?.message || 'Error al procesar el código de barras.' };
    } finally {
    await queryRunner.release();
  }
  }
  
}
