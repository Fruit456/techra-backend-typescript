import { FastifyInstance } from 'fastify';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'techra-postgres-server.postgres.database.azure.com',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'techra',
  user: process.env.DB_USER || 'techra_admin',
  password: process.env.DB_PASSWORD || '',
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

// Create connection pool
export const pool = new pg.Pool(dbConfig);

// Test database connection
export async function testConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    console.log('✅ Database connected:', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    return false;
  }
}

// Types
interface Train {
  id?: string;
  train_number: string;
  name: string;
  operator?: string;
  status?: string;
}

interface Wagon {
  id?: string;
  train_id: string;
  wagon_number: number;
  wagon_type: string;
  position: number;
  status?: string;
}

interface Aggregate {
  id?: string;
  aggregate_number: string;
  type: 'Hytt' | 'Salong';
  status?: string;
  current_wagon_id?: string;
  temperature_setpoint?: number;
  current_temperature?: number;
  pressure_value?: number;
  last_maintenance?: Date;
  next_maintenance?: Date;
}

// Database routes
export function registerDatabaseRoutes(fastify: FastifyInstance) {
  
  // Health check for database
  fastify.get('/api/db/health', async (request, reply) => {
    const isConnected = await testConnection();
    return { 
      database: isConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString()
    };
  });

  // ==================
  // TRAINS
  // ==================
  
  // Get all trains
  fastify.get('/api/trains', async (request, reply) => {
    try {
      const result = await pool.query(`
        SELECT t.*, COUNT(w.id) as wagon_count 
        FROM trains t
        LEFT JOIN wagons w ON t.id = w.train_id
        GROUP BY t.id
        ORDER BY t.train_number
      `);
      return result.rows;
    } catch (error) {
      console.error('Error fetching trains:', error);
      reply.code(500).send({ error: 'Failed to fetch trains' });
    }
  });

  // Get single train with wagons
  fastify.get('/api/trains/:id', async (request: any, reply) => {
    try {
      const { id } = request.params;
      
      // Get train
      const trainResult = await pool.query('SELECT * FROM trains WHERE id = $1', [id]);
      if (trainResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Train not found' });
      }
      
      // Get wagons with aggregates
      const wagonsResult = await pool.query(`
        SELECT w.*, a.aggregate_number, a.type as aggregate_type, a.status as aggregate_status
        FROM wagons w
        LEFT JOIN aggregates a ON w.id = a.current_wagon_id
        WHERE w.train_id = $1
        ORDER BY w.position
      `, [id]);
      
      return {
        ...trainResult.rows[0],
        wagons: wagonsResult.rows
      };
    } catch (error) {
      console.error('Error fetching train:', error);
      reply.code(500).send({ error: 'Failed to fetch train' });
    }
  });

  // Create new train with wagons
  fastify.post('/api/trains', async (request: any, reply) => {
    const { train_number, name, operator } = request.body;
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create train
      const trainResult = await client.query(
        'INSERT INTO trains (train_number, name, operator) VALUES ($1, $2, $3) RETURNING *',
        [train_number, name, operator || 'Öresundståg']
      );
      const train = trainResult.rows[0];
      
      // Create 5 wagons (X31 layout)
      const wagonTypes = ['M43 Hytt', 'M43 Salong', 'T47 Salong', 'M45 Salong', 'M45 Hytt'];
      for (let i = 0; i < 5; i++) {
        await client.query(
          'INSERT INTO wagons (train_id, wagon_number, wagon_type, position) VALUES ($1, $2, $3, $4)',
          [train.id, i + 1, wagonTypes[i], i + 1]
        );
      }
      
      await client.query('COMMIT');
      return train;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error creating train:', error);
      reply.code(500).send({ error: 'Failed to create train' });
    } finally {
      client.release();
    }
  });

  // Update train
  fastify.put('/api/trains/:id', async (request: any, reply) => {
    const { id } = request.params;
    const { name, operator, status } = request.body;
    
    try {
      const result = await pool.query(
        'UPDATE trains SET name = $1, operator = $2, status = $3 WHERE id = $4 RETURNING *',
        [name, operator, status, id]
      );
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Train not found' });
      }
      
      return result.rows[0];
    } catch (error) {
      console.error('Error updating train:', error);
      reply.code(500).send({ error: 'Failed to update train' });
    }
  });

  // Delete train
  fastify.delete('/api/trains/:id', async (request: any, reply) => {
    const { id } = request.params;
    
    try {
      const result = await pool.query('DELETE FROM trains WHERE id = $1 RETURNING *', [id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Train not found' });
      }
      
      return { success: true, deleted: result.rows[0] };
    } catch (error) {
      console.error('Error deleting train:', error);
      reply.code(500).send({ error: 'Failed to delete train' });
    }
  });

  // ==================
  // AGGREGATES
  // ==================
  
  // Get all aggregates
  fastify.get('/api/aggregates', async (request, reply) => {
    try {
      const result = await pool.query(`
        SELECT a.*, w.wagon_number, w.wagon_type, t.train_number
        FROM aggregates a
        LEFT JOIN wagons w ON a.current_wagon_id = w.id
        LEFT JOIN trains t ON w.train_id = t.id
        ORDER BY a.aggregate_number
      `);
      return result.rows;
    } catch (error) {
      console.error('Error fetching aggregates:', error);
      reply.code(500).send({ error: 'Failed to fetch aggregates' });
    }
  });

  // Get single aggregate
  fastify.get('/api/aggregates/:id', async (request: any, reply) => {
    try {
      const { id } = request.params;
      
      const result = await pool.query(`
        SELECT a.*, w.wagon_number, w.wagon_type, t.train_number, t.name as train_name
        FROM aggregates a
        LEFT JOIN wagons w ON a.current_wagon_id = w.id
        LEFT JOIN trains t ON w.train_id = t.id
        WHERE a.id = $1
      `, [id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Aggregate not found' });
      }
      
      // Get recent sensor readings
      const readingsResult = await pool.query(`
        SELECT * FROM sensor_readings 
        WHERE aggregate_id = $1 
        ORDER BY reading_timestamp DESC 
        LIMIT 10
      `, [id]);
      
      return {
        ...result.rows[0],
        recent_readings: readingsResult.rows
      };
    } catch (error) {
      console.error('Error fetching aggregate:', error);
      reply.code(500).send({ error: 'Failed to fetch aggregate' });
    }
  });

  // Create aggregate
  fastify.post('/api/aggregates', async (request: any, reply) => {
    const { aggregate_number, type, temperature_setpoint } = request.body;
    
    try {
      const result = await pool.query(
        `INSERT INTO aggregates (aggregate_number, type, temperature_setpoint) 
         VALUES ($1, $2, $3) RETURNING *`,
        [aggregate_number, type, temperature_setpoint || 22.0]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Error creating aggregate:', error);
      reply.code(500).send({ error: 'Failed to create aggregate' });
    }
  });

  // Assign aggregate to wagon
  fastify.post('/api/aggregates/:id/assign', async (request: any, reply) => {
    const { id } = request.params;
    const { wagon_id } = request.body;
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get old wagon_id for logging
      const oldResult = await client.query(
        'SELECT current_wagon_id FROM aggregates WHERE id = $1',
        [id]
      );
      
      // Update aggregate
      const result = await client.query(
        'UPDATE aggregates SET current_wagon_id = $1 WHERE id = $2 RETURNING *',
        [wagon_id, id]
      );
      
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Aggregate not found' });
      }
      
      // Log the move
      await client.query(
        `INSERT INTO aggregate_logs (aggregate_id, wagon_id, event_type, description, old_value, new_value)
         VALUES ($1, $2, 'moved', 'Aggregate reassigned to different wagon', $3, $4)`,
        [id, wagon_id, 
         JSON.stringify({ wagon_id: oldResult.rows[0].current_wagon_id }),
         JSON.stringify({ wagon_id })]
      );
      
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error assigning aggregate:', error);
      reply.code(500).send({ error: 'Failed to assign aggregate' });
    } finally {
      client.release();
    }
  });

  // Update aggregate status
  fastify.patch('/api/aggregates/:id/status', async (request: any, reply) => {
    const { id } = request.params;
    const { status } = request.body;
    
    try {
      const result = await pool.query(
        'UPDATE aggregates SET status = $1 WHERE id = $2 RETURNING *',
        [status, id]
      );
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Aggregate not found' });
      }
      
      // Log status change
      await pool.query(
        `INSERT INTO aggregate_logs (aggregate_id, event_type, description, new_value)
         VALUES ($1, 'status_change', 'Status updated', $2)`,
        [id, JSON.stringify({ status })]
      );
      
      return result.rows[0];
    } catch (error) {
      console.error('Error updating aggregate status:', error);
      reply.code(500).send({ error: 'Failed to update status' });
    }
  });

  // Record sensor reading
  fastify.post('/api/aggregates/:id/readings', async (request: any, reply) => {
    const { id } = request.params;
    const { temperature, pressure, humidity, power_consumption, error_codes } = request.body;
    
    try {
      // Record reading
      const result = await pool.query(
        `INSERT INTO sensor_readings 
         (aggregate_id, temperature, pressure, humidity, power_consumption, error_codes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, temperature, pressure, humidity, power_consumption, error_codes]
      );
      
      // Update current values in aggregate
      await pool.query(
        `UPDATE aggregates 
         SET current_temperature = $1, pressure_value = $2 
         WHERE id = $3`,
        [temperature, pressure, id]
      );
      
      return result.rows[0];
    } catch (error) {
      console.error('Error recording sensor reading:', error);
      reply.code(500).send({ error: 'Failed to record reading' });
    }
  });

  // Get aggregate logs
  fastify.get('/api/aggregates/:id/logs', async (request: any, reply) => {
    const { id } = request.params;
    
    try {
      const result = await pool.query(
        `SELECT * FROM aggregate_logs 
         WHERE aggregate_id = $1 
         ORDER BY created_at DESC 
         LIMIT 50`,
        [id]
      );
      return result.rows;
    } catch (error) {
      console.error('Error fetching logs:', error);
      reply.code(500).send({ error: 'Failed to fetch logs' });
    }
  });
}
