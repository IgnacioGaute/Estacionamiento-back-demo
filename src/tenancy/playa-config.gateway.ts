import { WebSocketGateway, WebSocketServer, OnGatewayConnection } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TenantSocketAccess } from './tenant-socket';
import { tenantContext } from './tenant-context';

// Avisa a las pantallas abiertas de una playa que el super admin cambió su modalidad, para que
// recarguen con los menús y pantallas que corresponden. El cambio llega desde la plataforma, sin
// scope de playa: se emite con un scope explícito y TenantSocketAccess revalida a cada cliente.
@WebSocketGateway({ cors: true })
export class PlayaConfigGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  constructor(private readonly access: TenantSocketAccess) {}
  handleConnection(client: Socket) { return this.access.connect(client); }
  emitModalidad(playa: { id: string; empresaId: string; modalidad: string }, actorId: string) {
    return tenantContext.run(
      { empresaId: playa.empresaId, playaId: playa.id, userId: actorId, role: 'SUPER_ADMIN', platform: true },
      () => this.access.emit(this.server, 'playa-modalidad', { playaId: playa.id, modalidad: playa.modalidad }),
    );
  }
}
