#!/usr/bin/env tsx
// Validate Telegram bot transport — channel IDs, permissions, sendMessage
import { sendMessage, getWebhookInfo } from '../src/lib/telegram/bot';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

async function getMe() {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const res   = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`);
  return res.json() as Promise<{ ok: boolean; result?: { username: string; id: number } }>;
}

async function testChannel(name: string, chatId: string) {
  console.log(`\n  Testing ${name}: ${chatId}`);
  const result = await sendMessage({
    chatId,
    text: `🔧 <b>SONAR v2 — Transport Test</b>\n\nPhase D validation. This confirms the ${name} channel is reachable.\n\n<i>You can delete this message.</i>`,
    parseMode: 'HTML',
  });
  if (result.ok) {
    console.log(`  ✅ ${name} → delivered (message_id=${result.messageId})`);
  } else {
    console.error(`  ❌ ${name} → FAILED: ${result.error}`);
  }
  return result.ok;
}

async function main() {
  console.log('SONAR v2 — Telegram Transport Validation');
  console.log('=========================================');

  const freeId    = process.env.TELEGRAM_CHANNEL_ID!;
  const premiumId = process.env.TELEGRAM_PREMIUM_CHANNEL_ID!;

  // 1. Bot identity
  const me = await getMe();
  if (me.ok && me.result) {
    console.log(`\nBot: @${me.result.username} (id=${me.result.id})`);
  } else {
    console.error('\n❌ Bot identity check failed — invalid TELEGRAM_BOT_TOKEN?');
    process.exit(1);
  }

  // 2. Webhook info
  const wh = await getWebhookInfo() as any;
  console.log(`Webhook URL: ${wh.result?.url || '(none)'}`);
  console.log(`Pending:     ${wh.result?.pending_update_count ?? 0}`);

  // 3. Channel tests
  let ok = true;
  ok = await testChannel('free channel', freeId)    && ok;
  ok = await testChannel('premium channel', premiumId) && ok;

  console.log(`\n${ok ? '✅ Transport validated' : '❌ Transport issues detected'}`);
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
