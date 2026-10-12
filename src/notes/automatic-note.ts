import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { tenantContext, TenantScope } from 'src/tenancy/tenant-context';

type AutomaticNote = {
  sourceKey: string;
  origin: string;
  sourceType: string;
  sourceId: string;
  description?: string | null;
  context?: string;
  usuarioId?: string | null;
};
type PendingNote = { noteId: string; authorId: string; scope?: TenantScope };
const QUEUE = 'automaticNotes';
const SNAPSHOTS = 'automaticNoteSnapshots';

/** La nota y su operación se confirman o se deshacen juntas. */
export async function publishAutomaticNote(manager: EntityManager, input: AutomaticNote) {
  const description = input.description?.trim();
  const scope = tenantContext.getStore();
  const authorId = input.usuarioId || scope?.userId;
  if (!description || !authorId) return;
  if (!manager.queryRunner?.isTransactionActive) {
    return manager.transaction(m => publishAutomaticNote(m, input));
  }
  const rows = await manager.query(`
    INSERT INTO notes (id, "playaId", "userId", description, "sourceKey", origin, "sourceType", "sourceId", context, date, hours, "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::time, CURRENT_TIMESTAMP)
    ON CONFLICT ("sourceKey") DO UPDATE SET
      description = EXCLUDED.description, context = EXCLUDED.context, origin = EXCLUDED.origin,
      "userId" = EXCLUDED."userId", date = EXCLUDED.date, hours = EXCLUDED.hours,
      "createdAt" = EXCLUDED."createdAt", "readBy" = '{}'
    WHERE notes.description IS DISTINCT FROM EXCLUDED.description
       OR notes.context IS DISTINCT FROM EXCLUDED.context
    RETURNING id`, [randomUUID(), scope?.playaId ?? null, authorId, description,
      input.sourceKey, input.origin, input.sourceType, input.sourceId, input.context ?? null]);
  if (rows[0]) {
    const queue: Map<string, PendingNote> = manager.queryRunner.data[QUEUE] ??= new Map();
    queue.set(rows[0].id, { noteId: rows[0].id, authorId, scope });
  }
}

/** No se anuncian notas de operaciones fallidas, ni antes del COMMIT exterior. */
export function installAutomaticNoteNotifications(ds: DataSource, send: (data: object) => Promise<unknown>) {
  const logger = new Logger('AutomaticNotes');
  ds.subscribers.push({
    afterTransactionStart(event) {
      const snapshots: Map<string, PendingNote>[] = event.queryRunner.data[SNAPSHOTS] ??= [];
      snapshots.push(new Map(event.queryRunner.data[QUEUE] ?? []));
    },
    afterTransactionCommit(event) {
      event.queryRunner.data[SNAPSHOTS]?.pop();
      if (event.queryRunner.isTransactionActive) return;
      const queue: Map<string, PendingNote> | undefined = event.queryRunner.data[QUEUE];
      delete event.queryRunner.data[QUEUE];
      delete event.queryRunner.data[SNAPSHOTS];
      for (const note of queue?.values() ?? []) {
        const emit = () => send({ id: randomUUID(), type: 'NEW_NOTE', noteId: note.noteId, authorId: note.authorId });
        void Promise.resolve().then(() => note.scope ? tenantContext.run(note.scope, emit) : emit())
          .catch(error => logger.warn(`No se pudo anunciar el aviso: ${error.message}`));
      }
    },
    afterTransactionRollback(event) {
      const previous = event.queryRunner.data[SNAPSHOTS]?.pop();
      if (event.queryRunner.isTransactionActive) event.queryRunner.data[QUEUE] = previous ?? new Map();
      else {
        delete event.queryRunner.data[QUEUE];
        delete event.queryRunner.data[SNAPSHOTS];
      }
    },
  });
}
