// ============================================================
// SONAR — Telegram Bot Client
// ============================================================
// Send-only wrapper using raw fetch to Telegram Bot API.
// No polling or webhook — SONAR only pushes outbound messages.
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN  — bot token from @BotFather
//   TELEGRAM_CHANNEL_ID — channel or chat ID to post alerts

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('[telegram/bot] Missing TELEGRAM_BOT_TOKEN env var');
  return token;
}

function getChannelId(): string {
  const id = process.env.TELEGRAM_CHANNEL_ID;
  if (!id) throw new Error('[telegram/bot] Missing TELEGRAM_CHANNEL_ID env var');
  return id;
}

// ── Low-level send ────────────────────────────────────────────

interface SendMessageOptions {
  chatId: string;
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown';
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
}

interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

export async function sendMessage(opts: SendMessageOptions): Promise<TelegramSendResult> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
    parse_mode: opts.parseMode ?? 'HTML',
    disable_web_page_preview: opts.disableWebPagePreview ?? true,
  };
  if (opts.disableNotification) body.disable_notification = true;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json() as { ok: boolean; result?: { message_id: number }; description?: string };

  if (!data.ok) {
    return { ok: false, error: data.description ?? `HTTP ${res.status}` };
  }

  return { ok: true, messageId: data.result?.message_id };
}

// ── Channel send ──────────────────────────────────────────────

/**
 * Send an HTML-formatted message to the configured alert channel.
 * Returns true on success, false on failure (caller should log).
 */
export async function sendToChannel(text: string): Promise<boolean> {
  const chatId = getChannelId();
  const result = await sendMessage({ chatId, text, parseMode: 'HTML' });
  return result.ok;
}

/**
 * Send a message to a specific chat/user (used by command handlers).
 * Returns true on success.
 */
export async function sendToChat(chatId: string, text: string): Promise<boolean> {
  const result = await sendMessage({ chatId, text, parseMode: 'HTML' });
  return result.ok;
}

/**
 * Check whether the bot credentials are configured.
 * Returns false if either env var is missing (no throw).
 */
export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
}
