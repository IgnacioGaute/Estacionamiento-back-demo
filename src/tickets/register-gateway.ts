import { WebSocketGateway, WebSocketServer, OnGatewayConnection } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TenantSocketAccess } from '../tenancy/tenant-socket';
@WebSocketGateway({ cors: true })
export class TicketGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  constructor(private readonly access: TenantSocketAccess) {}
  handleConnection(client: Socket) { return this.access.connect(client); }
  emitNewRegistration(data: any) { return this.access.emit(this.server, 'new-registration', data); }
}
