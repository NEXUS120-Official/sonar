import requests
import pandas as pd
from pathlib import Path

print("Ottenendo volume DEX SOL/USDC da DexScreener...")

url = "https://api.dexscreener.com/latest/dex/search?q=SOL%20USDC"
try:
    response = requests.get(url, timeout=10)
    data = response.json()
    pairs = data.get('pairs', [])
    
    total_volume = 0
    best_pair = None
    for pair in pairs:
        if pair.get('chainId') == 'solana':
            vol = pair.get('volume', {}).get('h24', 0)
            if vol > total_volume:
                total_volume = vol
                best_pair = pair
    
    print(f"Pair migliore: {best_pair.get('dexId', 'unknown')} - {best_pair.get('baseToken', {}).get('symbol', '?')}/{best_pair.get('quoteToken', {}).get('symbol', '?')}")
    print(f"Volume 24h: ${total_volume:,.0f}")
    print(f"Prezzo: ${best_pair.get('priceUsd', 'N/A')}")
    
    # Salva in CSV
    output_path = Path.home() / "sonar" / "data" / "dex_volume.csv"
    pd.DataFrame([{
        'timestamp': pd.Timestamp.now(),
        'dex': best_pair.get('dexId', 'unknown'),
        'pair': f"{best_pair.get('baseToken', {}).get('symbol', '?')}/{best_pair.get('quoteToken', {}).get('symbol', '?')}",
        'volume_24h': total_volume,
        'price_usd': float(best_pair.get('priceUsd', 0))
    }]).to_csv(output_path, index=False)
    print(f"Dati salvati in {output_path}")
except Exception as e:
    print(f"Errore: {e}")
