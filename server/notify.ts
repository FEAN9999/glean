import { cfg } from './config.ts';

/** Sends a Telegram message when the bot is configured. Never throws. */
export async function telegram(text: string, force = false): Promise<{ ok: boolean; error?: string }> {
  const t = cfg().telegram;
  if (!force && !t.enabled) return { ok: false, error: 'disabled' };
  if (!t.botToken || !t.chatId) return { ok: false, error: 'Thiếu bot token hoặc chat ID' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${t.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `Telegram trả về ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
