const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/home/goat/sonar/.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const EXCHANGE_ADDRS = [
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE',
];

const STAKING_ADDRS = [
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',
  'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb',
];

const DEFI_ADDRS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',
  'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
  'KAMINoy7YoEFNZwnPVRVFB1ok8bSimbvJpQjTNMW4DZ',
];

function classify(from, to) {
  const toEx = EXCHANGE_ADDRS.some(a => (to||'').slice(0,16) === a.slice(0,16));
  const fromEx = EXCHANGE_ADDRS.some(a => (from||'').slice(0,16) === a.slice(0,16));
  const toSt = STAKING_ADDRS.some(a => (to||'').slice(0,16) === a.slice(0,16));
  const fromSt = STAKING_ADDRS.some(a => (from||'').slice(0,16) === a.slice(0,16));
  const toDf = DEFI_ADDRS.some(a => (to||'').slice(0,16) === a.slice(0,16));
  const fromDf = DEFI_ADDRS.some(a => (from||'').slice(0,16) === a.slice(0,16));

  if (toEx) return { type: 'exchange_deposit', dir: 'outflow' };
  if (fromEx) return { type: 'exchange_withdrawal', dir: 'inflow' };
  if (toSt) return { type: 'stake', dir: 'internal' };
  if (fromSt) return { type: 'unstake', dir: 'internal' };
  if (toDf) return { type: 'defi_deposit', dir: 'internal' };
  if (fromDf) return { type: 'defi_withdrawal', dir: 'internal' };
  return null;
}

(async () => {
  const { data: movements } = await supabase.from('movements').select('*').eq('flow_type', 'unknown');
  if (!movements || movements.length === 0) { console.log('Nessun movimento da riclassificare'); return; }

  console.log('Riclassificazione di ' + movements.length + ' movimenti...');
  let updated = 0;
  for (const m of movements) {
    const result = classify(m.from_address || '', m.to_address || '');
    if (!result) continue;
    const { error } = await supabase.from('movements').update({ flow_type: result.type, flow_direction: result.dir }).eq('id', m.id);
    if (!error) updated++;
  }
  console.log('OK ' + updated + ' movimenti riclassificati');
})();
