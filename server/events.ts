import type { FastifyReply } from 'fastify';

/** Event type codes (kept compatible with the analysed realtime contract). */
export const Ev = {
  SystemNotification: 1000,
  NeedReload: 2000,
  NewSearch: 3001,
  NewSearchByAuthor: 3002,
  NewCommentSearch: 3003,
  NewCommentSearchByAuthor: 3004,
  NewScrape: 4001,
  UpdateScrape: 4002,
  UpdateScrapeProcess: 4003,
  UpdateDownloadImageProcess: 4004,
  FinishScrape: 4005,
  ManualSyncProgress: 5001,
  ManualSyncComplete: 5002,
  ManualSyncFailed: 5003,
  ProxyStatus: 5101,
  AutoSyncFinished: 5102,
  ConfigReloaded: 5103,
} as const;

interface Client {
  id: number;
  reply: FastifyReply;
  groups: Set<string>;
}

const clients = new Map<number, Client>();
let seq = 0;

export function addClient(reply: FastifyReply, groups: string[]) {
  const id = ++seq;
  clients.set(id, { id, reply, groups: new Set(groups) });
  return id;
}
export function removeClient(id: number) {
  clients.delete(id);
}
export function joinGroup(id: number, group: string) {
  clients.get(id)?.groups.add(group);
}
export function leaveGroup(id: number, group: string) {
  clients.get(id)?.groups.delete(group);
}
export const clientCount = () => clients.size;

function write(c: Client, payload: string) {
  try {
    c.reply.raw.write(payload);
  } catch {
    clients.delete(c.id);
  }
}

/**
 * Broadcast `{type, data, message}`. When `group` is given only clients that joined it
 * (or the wildcard `*`) receive the event — mirrors JoinGroup/LeaveGroup semantics.
 */
export function emit(type: number, data: unknown = null, message?: string, group?: string) {
  const payload = `data: ${JSON.stringify({ type, data, message: message ?? null })}\n\n`;
  for (const c of clients.values()) {
    if (group && !c.groups.has(group) && !c.groups.has('*')) continue;
    write(c, payload);
  }
}

setInterval(() => {
  for (const c of clients.values()) write(c, `: ping\n\n`);
}, 25_000).unref();
