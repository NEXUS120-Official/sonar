const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/home/goat/sonar/.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchAll(query) {
  let all = [], from = 0, limit = 1000;
  while (true) {
    const { data } = await query.range(from, from + limit - 1);
    if (!data || data.length === 0) break;
    all = all.concat(data); from += limit;
  }
  return all;
}

(async () => {
  const movements = await fetchAll(supabase.from('movements').select('*'));
  console.log('Movimenti totali:', movements.length);
  
  let inflow=0, outflow=0, staked=0, unstaked=0, defiIn=0, defiOut=0, large=0;
  const whales=new Set();
  const byType = {};
  
  for(const m of movements){
    const usd=m.amount_usd||0;
    if(usd>=50000) large++;
    if(m.whale_id) whales.add(m.whale_id);
    if(m.flow_type=='exchange_deposit') inflow+=usd;
    else if(m.flow_type=='exchange_withdrawal') outflow+=usd;
    else if(m.flow_type=='stake') staked+=usd;
    else if(m.flow_type=='unstake') unstaked+=usd;
    else if(m.flow_type=='defi_deposit') defiIn+=usd;
    else if(m.flow_type=='defi_withdrawal') defiOut+=usd;
    byType[m.flow_type] = (byType[m.flow_type]||0) + 1;
  }
  
  console.log('Distribuzione:', JSON.stringify(byType));
  
  const netExchange=outflow-inflow;
  const netStaking=staked-unstaked;
  const netDefi=defiIn-defiOut;
  let biasScore=0;
  if(netExchange<-500000) biasScore+=50; else if(netExchange<-100000) biasScore+=25; else if(netExchange>500000) biasScore-=50; else if(netExchange>100000) biasScore-=25;
  if(netStaking>200000) biasScore+=20; else if(netStaking<-200000) biasScore-=20;
  if(netDefi>100000) biasScore+=10; else if(netDefi<-100000) biasScore-=10;
  biasScore=Math.max(-100,Math.min(100,biasScore));
  const bias=biasScore>20?'bullish':biasScore<-20?'bearish':'neutral';
  
  const {error}=await supabase.from('flow_snapshots').upsert({
    snapshot_time:new Date().toISOString(), window_hours:24,
    sol_exchange_inflow_usd:inflow, sol_exchange_outflow_usd:outflow, sol_net_exchange_flow_usd:netExchange,
    sol_staked_usd:staked, sol_unstaked_usd:unstaked, net_staking_flow_usd:netStaking,
    defi_deposit_usd:defiIn, defi_withdrawal_usd:defiOut, net_defi_flow_usd:netDefi,
    large_movements_count:large, unique_whales_active:whales.size,
    market_bias:bias, bias_score:biasScore
  },{onConflict:'snapshot_time,window_hours'});
  
  if(error){console.log('ERRORE:',error.message);return;}
  console.log('✅ Snapshot aggiornato con', movements.length, 'movimenti');
  console.log('Net Exchange:', (netExchange/1e6).toFixed(1)+'M');
  console.log('Bias:', biasScore, '('+bias+')');
})();
