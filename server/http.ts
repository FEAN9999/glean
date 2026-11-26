import type { FastifyReply, FastifyRequest } from 'fastify';
import { cfg, type AppConfig } from './config.ts';

/**
 * An error the API sends back. Write its message as [Vietnamese, English]; a plain string (an
 * error passed through, a notice the user typed) is sent as it is in both languages.
 */
export class ApiError extends Error {
  /** Sent instead of `message` when the request asks for English. */
  readonly en: string;
  constructor(
    public status: number,
    public code: string,
    message: string | readonly [vi: string, en: string],
    /** Hint for the client on how to surface the error: toast | inline | silent | banner */
    public display: 'toast' | 'inline' | 'silent' | 'banner' = 'toast',
  ) {
    const [vi, en] = typeof message === 'string' ? [message, message] : message;
    super(vi);
    this.en = en;
  }
}

export const ok = <T>(data: T, extra: Record<string, unknown> = {}) => ({ success: true, data, ...extra });

export function lang(req: FastifyRequest): 'vi' | 'en' {
  return String(req.headers['accept-language'] ?? '').toLowerCase().startsWith('en') ? 'en' : 'vi';
}

const PAUSED_MSG = {
  vi: 'Tính năng đang tạm dừng.',
  en: 'This feature is paused.',
};

export function assertNotPaused(req: FastifyRequest, feature: keyof AppConfig['maintenance']) {
  const flag = cfg().maintenance[feature];
  if (flag.isPaused) throw new ApiError(503, 'FEATURE_PAUSED', flag.message || PAUSED_MSG[lang(req)], 'banner');
}

export function sendError(reply: FastifyReply, e: ApiError) {
  reply.header('error-message-type', e.display);
  // `messages` has both languages, so a page can show the error again after its language is changed.
  return reply.code(e.status).send({
    success: false,
    code: e.code,
    message: lang(reply.request) === 'en' ? e.en : e.message,
    messages: { vi: e.message, en: e.en },
  });
}

export const intParam = (v: unknown, def: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
};
