import { WebSocketGateway, WebSocketServer, OnGatewayConnection } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TenantSocketAccess } from '../tenancy/tenant-socket';
import { operationContext } from 'src/common/operation-context';
@WebSocketGateway({ cors: true })
export class TicketGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  constructor(private readonly access: TenantSocketAccess) {}
  handleConnection(client: Socket) { return this.access.connect(client); }
  emitNewRegistration(data: any) {
    const context = operationContext.getStore();
    if (context) { context.afterCommit.push(() => this.access.emit(this.server, 'new-registration', data)); return; }
    return this.access.emit(this.server, 'new-registration', data);
  }
}
