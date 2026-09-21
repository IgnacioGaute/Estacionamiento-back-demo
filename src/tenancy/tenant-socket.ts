import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Socket, Server } from 'socket.io';
import { TenantAccessService } from './tenant-access';
import { tenantContext } from './tenant-context';
@Injectable()
export class TenantSocketAccess {
  constructor(private readonly access: TenantAccessService, private readonly config: ConfigService) {}
  async connect(client: Socket) {
    try {
      const payload = await new JwtService({ secret: this.config.getOrThrow('NEXTAUTH_SECRET') }).verifyAsync(client.handshake.auth?.token, { algorithms: ['HS256'] });
      if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) throw new Error('Expired');
      const { user } = await this.access.context(payload.id);
      if ((payload.authVersion ?? 0) !== user.authVersion) throw new Error('Revoked');
      const scope = await this.access.resolve(payload.id, client.handshake.auth?.playaId);
      await client.join(`playa:${scope.playaId}`);
      client.data.tenant = scope;
      client.data.expiresAt = payload.exp;
      client.data.authVersion = payload.authVersion ?? 0;
    } catch { client.disconnect(true); }
  }
  async emit(server: Server, event: string, data: unknown) {
    const scope = tenantContext.getStore();
    if (!scope?.playaId) return;
    const clients = await server.in(`playa:${scope.playaId}`).fetchSockets();
    await Promise.all(clients.map(async client => {
      try {
        if (!client.data.tenant || client.data.expiresAt * 1000 <= Date.now()) throw new Error('Expired');
        const { user } = await this.access.context(client.data.tenant.userId);
        if (client.data.authVersion !== user.authVersion) throw new Error('Revoked');
        await this.access.resolve(client.data.tenant.userId, scope.playaId);
        client.emit(event, data);
      } catch { client.disconnect(true); }
    }));
  }
}
