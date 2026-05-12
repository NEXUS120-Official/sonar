const fs = require("fs");
let env = fs.readFileSync(".env.local", "utf8");
env = env.replace(/^HELIUS_API_KEY=/m, "# HELIUS_API_KEY=");
env += "\n# Alchemy (nuovo provider)\n";
env += "ALCHEMY_API_KEY=P1PXzifVo6e8HeAAro4UV\n";
env = env.replace(/^SOLANA_RPC_URL=.*/m, "SOLANA_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/P1PXzifVo6e8HeAAro4UV");
env = env.replace(/^SOLANA_RPC_FALLBACK_URL=.*/m, "SOLANA_RPC_FALLBACK_URL=https://solana-mainnet.g.alchemy.com/v2/P1PXzifVo6e8HeAAro4UV");
fs.writeFileSync(".env.local", env);
console.log("✅ Configurazione Alchemy completata");
