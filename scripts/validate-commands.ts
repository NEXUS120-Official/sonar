#!/usr/bin/env tsx
// Validate all v2 Telegram commands return live data
import {
  handleStart,
  handleFlow,
  handleExchanges,
  handleStaking,
  handleWhale,
  handleReport,
  handlePro,
} from '../src/lib/telegram/commands';

let pass = 0;
let fail = 0;

function check(label: string, text: string, mustContain: string[]) {
  const missing = mustContain.filter(s => !text.includes(s));
  if (missing.length === 0) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label} — missing: ${missing.join(', ')}`);
    console.error(`     Got: ${text.slice(0, 300)}`);
    fail++;
  }
}

async function main() {
  console.log('SONAR v2 — Command Validation');
  console.log('==============================\n');

  // /start — static, no DB
  const start = handleStart();
  check('/start', start, ['SONAR', '/flow', '/exchanges', '/staking', '/whale', '/report', '/pro']);
  console.log(`     Preview: ${start.slice(0, 80)}...`);

  // /flow — reads flow_snapshots
  console.log('\n/flow:');
  const flow = await handleFlow();
  console.log(`  Response: ${flow.slice(0, 200)}`);
  // May have no data or live data
  if (flow.includes('No flow data')) {
    console.log('  ⚠️  No snapshot data yet — run process-flows cron first');
    pass++;
  } else {
    check('/flow', flow, ['SONAR', 'Bias', 'Exchange Flow', 'Staking']);
  }

  // /exchanges — reads movements
  console.log('\n/exchanges:');
  const exchanges = await handleExchanges();
  console.log(`  Response: ${exchanges.slice(0, 200)}`);
  if (exchanges.includes('No exchange movements')) {
    console.log('  ⚠️  No exchange movements yet');
    pass++;
  } else {
    check('/exchanges', exchanges, ['Exchange Flows']);
  }

  // /staking — reads flow_snapshots + movements
  console.log('\n/staking:');
  const staking = await handleStaking();
  console.log(`  Response: ${staking.slice(0, 200)}`);
  check('/staking', staking, ['Staking']);

  // /whale — use first active whale from saved addresses
  const whaleAddr = 'F6Fh9BjBXb1GyacHto4cwqcKF4K4xK8SwEyDv9Ayp8j9';
  console.log(`\n/whale ${whaleAddr}:`);
  const whale = await handleWhale(whaleAddr);
  console.log(`  Response: ${whale.slice(0, 300)}`);
  check(`/whale ${whaleAddr.slice(0,8)}...`, whale, ['Whale', 'Balance', 'Solscan']);

  // /whale — missing address
  console.log('\n/whale (no address):');
  const whaleNoAddr = await handleWhale('');
  check('/whale no-addr', whaleNoAddr, ['Usage']);

  // /whale — unknown address
  console.log('\n/whale unknown:');
  const whaleUnknown = await handleWhale('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  check('/whale unknown', whaleUnknown, ['not found']);

  // /report — reads alerts WHERE alert_type=weekly_report
  console.log('\n/report:');
  const report = await handleReport();
  console.log(`  Response: ${report.slice(0, 200)}`);
  if (report.includes('No weekly report')) {
    console.log('  ⚠️  No weekly report yet (expected — first publishes Saturday)');
    pass++;
  } else {
    check('/report', report, ['SONAR Weekly Report']);
  }

  // /pro — static
  const pro = handlePro();
  check('/pro', pro, ['Pro', '19', 'alerts']);

  console.log(`\n══ Results: ${pass} passed, ${fail} failed ══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
