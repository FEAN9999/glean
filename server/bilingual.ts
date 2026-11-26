/** A text in both languages: [Vietnamese, English]. */
export type Bi = readonly [vi: string, en: string];

/**
 * An error raised outside a request (a sieve job, a sync run, a backup). Its message is kept and
 * shown later, so it is written in both languages; `message` is the Vietnamese one.
 */
export class BiError extends Error {
  readonly en: string;
  constructor([vi, en]: Bi) {
    super(vi);
    this.en = en;
  }
}

/** Both languages of an error. One with a single message (network, file system) reads the same in both. */
export function biOf(e: unknown): Bi {
  const vi = e instanceof Error ? e.message : String(e);
  const en = (e as { en?: unknown } | null)?.en;
  return [vi, typeof en === 'string' ? en : vi];
}

/**
 * One string that holds both languages, for a database column, a log line or a realtime event.
 * The web app shows the reader's language (`unpack` in web/src/lib/i18n.tsx). A text that reads
 * the same in both languages stays plain, like the rows saved before both were kept.
 */
export const pack = ([vi, en]: Bi): string => (vi === en ? vi : JSON.stringify({ vi, en }));
