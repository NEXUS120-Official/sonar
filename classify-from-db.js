const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/home/goat/sonar/.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  // Carica tutti gli indirizzi noti
  const { data: knownAddrs } = await supabase.from('known_addresses').select('address, category, sub_category');
  if (!knownAddrs || knownAddrs.length === 0) { console.log('Nessun indirizzo noto'); return; }
  
  console.log('Indirizzi noti caricati:', knownAddrs.length);
  
  // Costruisci mappa: chiave = primi 16 caratteri dell'indirizzo
  const addrMap = new Map();
  knownAddrs.forEach(a => {
    addrMap.set(a.address.slice(0,16), { category: a.category, sub: a.sub_category });
  });
  
  // Prendi tutti i movimenti unknown
  const { data: movements } = await supabase.from('movements').select('*').eq('flow_type', 'unknown');
  if (!movements || movements.length === 0) { console.log('Nessun movimento da classificare'); return; }
  
  console.log('Movimenti da classificare:', movements.length);
  
  let updated = 0;
  for (const m of movements) {
    const fromKey = (m.from_address || '').slice(0,16);
    const toKey = (m.to_address || '').slice(0,16);
    
    const toMatch = addrMap.get(toKey);
    const fromMatch = addrMap.get(fromKey);
    
    let flowType = 'unknown';
    let flowDir = 'internal';
    let exchange = null;
    let protocol = null;
    
    if (toMatch?.category === 'exchange') {
      flowType = 'exchange_deposit';
      flowDir = 'outflow';
      exchange = toMatch.sub;
    } else if (fromMatch?.category === 'exchange') {
      flowType = 'exchange_withdrawal';
      flowDir = 'inflow';
      exchange = fromMatch.sub;
    } else if (toMatch?.category === 'staking') {
      flowType = 'stake';
      flowDir = 'internal';
      protocol = toMatch.sub;
    } else if (fromMatch?.category === 'staking') {
      flowType = 'unstake';
      flowDir = 'internal';
      protocol = fromMatch.sub;
    } else if (toMatch?.category === 'defi') {
      flowType = 'defi_deposit';
      flowDir = 'internal';
      protocol = toMatch.sub;
    } else if (fromMatch?.category === 'defi') {
      flowType = 'defi_withdrawal';
      flowDir = 'internal';
      protocol = fromMatch.sub;
    } else {
      continue; // non classificabile
    }
    
    const { error } = await supabase.from('movements').update({
      flow_type: flowType,
      flow_direction: flowDir,
      exchange: exchange,
      protocol: protocol
    }).eq('id', m.id);
    
    if (!error) updated++;
  }
  
  console.log('✅', updated, 'movimenti riclassificati');
})();
