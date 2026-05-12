import ccxt
import pandas as pd
from pathlib import Path
from datetime import datetime

print("🔄 Scaricamento dati storici SOL/USDT da Binance...")
exchange = ccxt.binance()
since = exchange.parse8601('2020-04-01T00:00:00Z')
all_candles = []

while since < exchange.parse8601('2026-06-01T00:00:00Z'):
    try:
        candles = exchange.fetch_ohlcv('SOL/USDT', '1d', since=since, limit=1000)
        if not candles:
            break
        all_candles += candles
        since = candles[-1][0] + 1
        print(f"   Scaricate {len(candles)} candele, ultima: {datetime.utcfromtimestamp(candles[-1][0]/1000).strftime('%Y-%m-%d')}")
    except Exception as e:
        print(f"   Errore: {e}, riprovo...")
        continue

df = pd.DataFrame(all_candles, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
df.to_csv(Path.home() / 'sonar' / 'data' / 'SOLUSDT_1day.csv', index=False)
print(f"✅ Salvati {len(df)} giorni di prezzi SOL/USDT in ~/sonar/data/SOLUSDT_1day.csv")
