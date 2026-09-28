import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { createPool } from './db.js';
import { loadConfig } from './config.js';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !password || password.length < 16) throw new Error('BOOTSTRAP_ADMIN_EMAIL and a 16+ character BOOTSTRAP_ADMIN_PASSWORD are required.');
const pool = createPool(loadConfig());
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kolbe-bootstrap-admin'))");
    const existing = await client.query("SELECT 1 FROM user_roles WHERE role_code = 'admin' LIMIT 1");
    if (existing.rowCount) throw new Error('An administrator already exists. Bootstrap is disabled.');
    const id = randomUUID();
    await client.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [id, email, await argon2.hash(password, { type: argon2.argon2id }), 'مدیر کلبه']);
    await client.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [id, 'admin']);
    await client.query('COMMIT');
    console.log(`Administrator created: ${email}`);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
} finally { await pool.end(); }
