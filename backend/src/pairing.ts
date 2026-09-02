import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';

const exchangeSchema = z.object({
  code: z.string().min(8).max(32),
});

function normalizeCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function hashCode(code: string): string {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

function createReadableCode(): string {
  const raw = randomBytes(6).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export async function registerPairingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/pairing-codes', async () => {
    await pool.query(`DELETE FROM pairing_codes WHERE expires_at < now() OR used_at IS NOT NULL`);
    const code = createReadableCode();
    const result = await pool.query<{ expires_at: Date }>(
      `INSERT INTO pairing_codes (code_hash, expires_at)
       VALUES ($1, now() + interval '15 minutes')
       RETURNING expires_at`,
      [hashCode(code)],
    );
    return {
      data: {
        code,
        expiresAt: result.rows[0]?.expires_at.toISOString(),
      },
    };
  });

  app.post('/v1/pair/exchange', async (request, reply) => {
    const input = exchangeSchema.parse(request.body);
    const result = await pool.query(
      `UPDATE pairing_codes
       SET used_at=now()
       WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now()
       RETURNING code_hash`,
      [hashCode(input.code)],
    );
    if (!result.rowCount) {
      return reply.code(400).send({ error: 'invalid_pairing_code' });
    }
    return { data: { token: config.APP_TOKEN } };
  });
}
