#!/bin/bash
cd ~/sonar
echo "=== SONAR Daily Backfill — $(date) ===" >> ~/sonar/backups/backfill.log
npx tsx scripts/backfill-alchemy-enriched.ts >> ~/sonar/backups/backfill.log 2>&1
node recalc-snapshot.js >> ~/sonar/backups/backfill.log 2>&1
echo "✅ Completato alle $(date)" >> ~/sonar/backups/backfill.log
