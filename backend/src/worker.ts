import { config } from './config.js';
import { closeDatabase } from './db.js';
import { processDueHeartbeats } from './heartbeat.js';
import { processPushOutbox } from './push.js';

let stopping = false;

async function tick(): Promise<void> {
  if (stopping) return;

  try {
    const results = await processDueHeartbeats({ demoMode: config.HEARTBEAT_DEMO_MODE });
    if (results.length > 0) {
      console.info('heartbeat results', results);
    }
  } catch (error) {
    console.error('heartbeat tick failed', error);
  }
  try {
    const delivered = await processPushOutbox();
    if (delivered > 0) console.info('push outbox processed', { delivered });
  } catch (error) {
    console.error('push outbox tick failed', error);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.info(`worker received ${signal}`);
  clearInterval(timer);
  await closeDatabase();
  process.exit(0);
}

await tick();
const timer = setInterval(() => void tick(), config.HEARTBEAT_POLL_MS);
timer.unref();

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
