import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, pool } from './db.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(currentDir, '../migrations');

async function migrate(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [7_104_202_026]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const filenames = (await readdir(migrationsDir))
      .filter((filename) => filename.endsWith('.sql'))
      .sort();

    for (const filename of filenames) {
      // Git/Windows may materialize SQL with CRLF while Linux uses LF.  The
      // migration text is identical, so hash a canonical newline form to keep
      // deployments portable without weakening the applied-migration guard.
      const sql = (await readFile(path.join(migrationsDir, filename), 'utf8')).replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE filename = $1',
        [filename],
      );

      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Migration ${filename} was changed after being applied.`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum],
        );
        await client.query('COMMIT');
        console.info(`Applied migration ${filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [7_104_202_026]);
    client.release();
  }
}

migrate()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
