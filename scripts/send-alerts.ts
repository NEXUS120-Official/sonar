import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramMessage(text: string): Promise<boolean> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram token o chat ID mancanti, impossibile inviare il messaggio.');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
    const json = await res.json();
    return json.ok === true;
  } catch (e) {
    console.error('Errore invio Telegram:', e);
    return false;
  }
}

async function main() {
  console.log('📤 Invio alert Telegram...');

  // Prendi alert non ancora inviati (sent_telegram_free = false)
  const { data: alerts } = await supabase
    .from('alerts')
    .select('*')
    .eq('sent_telegram_free', false)
    .order('created_at', { ascending: true })
    .limit(10); // massimo 10 a esecuzione per stare nei limiti

  if (!alerts || alerts.length === 0) {
    console.log('Nessun alert da inviare.');
    return;
  }

  console.log(`Trovati ${alerts.length} alert da inviare.`);

  for (const alert of alerts) {
    // Formatta il messaggio
    const severityEmoji = alert.severity === 'major' ? '🔴' : alert.severity === 'significant' ? '🟠' : '🟡';
    const message = `<b>${severityEmoji} ${alert.title}</b>\n\n${alert.body}\n\n<em>${new Date(alert.created_at).toISOString()}</em>`;

    const sent = await sendTelegramMessage(message);

    if (sent) {
      // Marca come inviato
      await supabase
        .from('alerts')
        .update({ sent_telegram_free: true, sent_at: new Date().toISOString() })
        .eq('id', alert.id);
      console.log(`✅ Alert inviato: ${alert.title}`);
    } else {
      console.log(`❌ Fallito invio per: ${alert.title}`);
    }

    // Breve pausa per non superare i rate limit di Telegram (30 msg/sec)
    await new Promise(r => setTimeout(r, 50));
  }
}

main().catch(console.error);
