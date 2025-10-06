import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// PostgreSQL connection pool
export const pool = new pg.Pool({
  host: process.env.DB_HOST || 'techra-postgres-server.postgres.database.azure.com',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'techra',
  user: process.env.DB_USER || 'techra_admin',
  password: process.env.DB_PASSWORD || '',
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

// Test database connection
export async function testConnection(): Promise<void> {
  try {
    const client = await pool.connect();
    const res = await client.query('SELECT NOW()');
    client.release();
    console.log('✅ Database connected:', res.rows[0]?.now);
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    throw err;
  }
}

export default pool;

