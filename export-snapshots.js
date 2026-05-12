const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
require('dotenv').config({ path: '/home/goat/sonar/.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  let all = [], from = 0, limit = 1000;
  while (true) {
    const { data } = await supabase.from('flow_snapshots').select('*').range(from, from + limit - 1);
    if (!data || data.length === 0) break;
    all = all.concat(data); from += limit;
  }
  fs.writeFileSync('backups/flow_snapshots.json', JSON.stringify(all));
  console.log('✅ Esportati', all.length, 'snapshot in backups/flow_snapshots.json');
})();
