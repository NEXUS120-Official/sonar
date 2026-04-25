import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;

export interface SystemHeartbeatInput {
  component: string;
  status: 'ok' | 'degraded' | 'down' | 'active' | 'idle' | 'unauthorized' | 'error' | 'unknown';
  source?: string | null;
  message?: string | null;
  meta?: Record<string, unknown>;
}

export async function writeSystemHeartbeat(
  db: Db,
  input: SystemHeartbeatInput,
): Promise<void> {
  const row = {
    component: input.component,
    status: input.status,
    source: input.source ?? null,
    message: input.message ?? null,
    meta: input.meta ?? {},
    updated_at: new Date().toISOString(),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('system_heartbeats')
    .upsert(row as any, { onConflict: 'component' });

  if (error) throw error;
}

export async function writeSystemHeartbeatSafe(
  db: Db,
  input: SystemHeartbeatInput,
): Promise<void> {
  try {
    await writeSystemHeartbeat(db, input);
  } catch (err) {
    console.warn('[system-heartbeats] failed', {
      component: input.component,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
