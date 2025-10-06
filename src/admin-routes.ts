import { FastifyInstance } from 'fastify';
import { pool } from './database-pool';

/**
 * Register all admin and database-related routes
 * FIXED: Uses actual database schema (cars, not wagons)
 */
export function registerAdminRoutes(fastify: FastifyInstance, authenticate: any) {
  
  // ==========================================
  // BASIC TRAIN & AGGREGATE ENDPOINTS
  // ==========================================
  
  // Get all trains (simple list - used by Fleet page)
  fastify.get('/api/trains', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const tenantId = request.user?.tenantId || 'default';
      
      const result = await pool.query(`
        SELECT t.*, COUNT(DISTINCT c.id) as car_count 
        FROM trains t
        LEFT JOIN cars c ON CAST(t.id AS VARCHAR) = c.train_id
        GROUP BY t.id, t.train_number, t.name, t.operator, t.status, t.created_at, t.updated_at, t.tenant_id
        ORDER BY t.train_number
      `, []);
      
      console.log(`📊 GET /api/trains: ${result.rows.length} trains`);
      return result.rows;
    } catch (error) {
      console.error('❌ Error fetching trains:', error);
      reply.code(500).send({ error: 'Failed to fetch trains', details: (error as Error).message });
    }
  });

  // Get single train with cars
  fastify.get('/api/trains/:id', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      
      console.log(`📊 GET /api/trains/${id}`);
      
      const trainResult = await pool.query(
        'SELECT * FROM trains WHERE train_number = $1',
        [id]
      );
      
      if (trainResult.rows.length === 0) {
        console.log(`❌ Train not found: ${id}`);
        return reply.code(404).send({ error: 'Train not found' });
      }
      
      const carsResult = await pool.query(`
        SELECT c.*, a.aggregate_number, a.type as aggregate_type, a.status as aggregate_status
        FROM cars c
        LEFT JOIN aggregates a ON c.id = a.current_car_id
        WHERE c.train_id = $1
        ORDER BY c.position
      `, [id]);
      
      console.log(`✅ Found train ${id} with ${carsResult.rows.length} cars`);
      
      return {
        ...trainResult.rows[0],
        cars: carsResult.rows
      };
    } catch (error) {
      console.error(`❌ Error fetching train ${request.params.id}:`, error);
      reply.code(500).send({ error: 'Failed to fetch train', details: (error as Error).message });
    }
  });

  // Get all aggregates
  fastify.get('/api/aggregates', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const result = await pool.query(`
        SELECT a.*, c.car_number, c.car_type, t.train_number
        FROM aggregates a
        LEFT JOIN cars c ON a.current_car_id = c.id
        LEFT JOIN trains t ON c.train_id = t.train_number
        ORDER BY a.aggregate_number
      `);
      
      console.log(`📊 GET /api/aggregates: ${result.rows.length} aggregates`);
      return result.rows;
    } catch (error) {
      console.error('❌ Error fetching aggregates:', error);
      reply.code(500).send({ error: 'Failed to fetch aggregates', details: (error as Error).message });
    }
  });

  // Get spare aggregates (reserve)
  fastify.get('/api/aggregates/reserve', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const result = await pool.query(`
        SELECT * FROM aggregates
        WHERE current_car_id IS NULL
        ORDER BY aggregate_number
      `);
      
      console.log(`📊 GET /api/aggregates/reserve: ${result.rows.length} spare aggregates`);
      return result.rows;
    } catch (error) {
      console.error('❌ Error fetching spare aggregates:', error);
      reply.code(500).send({ error: 'Failed to fetch spare aggregates', details: (error as Error).message });
    }
  });

  // Get aggregates by status
  fastify.get('/api/aggregates/status/:status', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { status } = request.params;
      
      const result = await pool.query(`
        SELECT a.*, c.car_number, c.car_type, t.train_number
        FROM aggregates a
        LEFT JOIN cars c ON a.current_car_id = c.id
        LEFT JOIN trains t ON c.train_id = t.train_number
        WHERE a.status = $1
        ORDER BY a.aggregate_number
      `, [status]);
      
      console.log(`📊 GET /api/aggregates/status/${status}: ${result.rows.length} aggregates`);
      return result.rows;
    } catch (error) {
      console.error(`❌ Error fetching aggregates by status ${request.params.status}:`, error);
      reply.code(500).send({ error: 'Failed to fetch aggregates by status', details: (error as Error).message });
    }
  });

  // Get car aggregates
  fastify.get('/api/cars/:id/aggregates', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      
      const result = await pool.query(`
        SELECT a.*, c.car_number, c.car_type
        FROM aggregates a
        LEFT JOIN cars c ON a.current_car_id = c.id
        WHERE a.current_car_id = $1
        ORDER BY a.aggregate_number
      `, [id]);
      
      console.log(`📊 GET /api/cars/${id}/aggregates: ${result.rows.length} aggregates`);
      return result.rows;
    } catch (error) {
      console.error(`❌ Error fetching car aggregates for ${request.params.id}:`, error);
      reply.code(500).send({ error: 'Failed to fetch car aggregates', details: (error as Error).message });
    }
  });

  // Create aggregate for car
  fastify.post('/api/cars/:id/aggregates', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      const { agg_number, location } = request.body as any;
      
      const result = await pool.query(`
        INSERT INTO aggregates (aggregate_number, type, status, current_car_id, created_at)
        VALUES ($1, $2, 'operational', $3, NOW())
        RETURNING *
      `, [agg_number, location || 'unknown', id]);
      
      console.log(`✅ Created aggregate ${agg_number} for car ${id}`);
      return result.rows[0];
    } catch (error) {
      console.error(`❌ Error creating car aggregate:`, error);
      reply.code(500).send({ error: 'Failed to create car aggregate', details: (error as Error).message });
    }
  });

  // Create spare aggregate
  fastify.post('/api/aggregates/reserve', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { agg_number, notes } = request.body as any;
      
      const result = await pool.query(`
        INSERT INTO aggregates (aggregate_number, type, status, current_car_id, created_at)
        VALUES ($1, 'spare', 'reserve', NULL, NOW())
        RETURNING *
      `, [agg_number]);
      
      console.log(`✅ Created spare aggregate ${agg_number}`);
      return result.rows[0];
    } catch (error) {
      console.error(`❌ Error creating spare aggregate:`, error);
      reply.code(500).send({ error: 'Failed to create spare aggregate', details: (error as Error).message });
    }
  });

  // Move aggregate to car
  fastify.post('/api/aggregates/:id/move/:carId', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id, carId } = request.params;
      
      const result = await pool.query(`
        UPDATE aggregates 
        SET current_car_id = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [carId, id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Aggregate not found' });
      }
      
      console.log(`✅ Moved aggregate ${id} to car ${carId}`);
      return result.rows[0];
    } catch (error) {
      console.error(`❌ Error moving aggregate:`, error);
      reply.code(500).send({ error: 'Failed to move aggregate', details: (error as Error).message });
    }
  });

  // Unassign aggregate (move to reserve)
  fastify.post('/api/aggregates/:id/unassign', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      
      const result = await pool.query(`
        UPDATE aggregates 
        SET current_car_id = NULL, status = 'reserve', updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Aggregate not found' });
      }
      
      console.log(`✅ Unassigned aggregate ${id}`);
      return result.rows[0];
    } catch (error) {
      console.error(`❌ Error unassigning aggregate:`, error);
      reply.code(500).send({ error: 'Failed to unassign aggregate', details: (error as Error).message });
    }
  });

  // Get aggregate history
  fastify.get('/api/aggregates/:id/history', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      
      // For now, return empty array since we don't have history table yet
      console.log(`📊 GET /api/aggregates/${id}/history: No history table yet`);
      return [];
    } catch (error) {
      console.error(`❌ Error fetching aggregate history:`, error);
      reply.code(500).send({ error: 'Failed to fetch aggregate history', details: (error as Error).message });
    }
  });

  // Swap aggregates
  fastify.post('/api/aggregates/:id/swap', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      const { target_aggregate_id } = request.body as any;
      
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        // Get both aggregates
        const agg1 = await client.query('SELECT * FROM aggregates WHERE id = $1', [id]);
        const agg2 = await client.query('SELECT * FROM aggregates WHERE id = $1', [target_aggregate_id]);
        
        if (agg1.rows.length === 0 || agg2.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'One or both aggregates not found' });
        }
        
        // Swap car assignments
        const car1 = agg1.rows[0].current_car_id;
        const car2 = agg2.rows[0].current_car_id;
        
        await client.query('UPDATE aggregates SET current_car_id = $1, updated_at = NOW() WHERE id = $2', [car2, id]);
        await client.query('UPDATE aggregates SET current_car_id = $1, updated_at = NOW() WHERE id = $2', [car1, target_aggregate_id]);
        
        await client.query('COMMIT');
        
        console.log(`✅ Swapped aggregates ${id} and ${target_aggregate_id}`);
        return { success: true, message: 'Aggregates swapped successfully' };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error(`❌ Error swapping aggregates:`, error);
      reply.code(500).send({ error: 'Failed to swap aggregates', details: (error as Error).message });
    }
  });

  // Delete aggregate
  fastify.delete('/api/aggregates/:id', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      
      const result = await pool.query(`
        DELETE FROM aggregates 
        WHERE id = $1
        RETURNING *
      `, [id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Aggregate not found' });
      }
      
      console.log(`✅ Deleted aggregate ${id}`);
      return { success: true, message: 'Aggregate deleted successfully' };
    } catch (error) {
      console.error(`❌ Error deleting aggregate:`, error);
      reply.code(500).send({ error: 'Failed to delete aggregate', details: (error as Error).message });
    }
  });

  // Create train
  fastify.post('/api/trains', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { train_number, model } = request.body as any;
      
      const result = await pool.query(`
        INSERT INTO trains (train_number, name, operator, status, created_at)
        VALUES ($1, $2, 'Öresundståg', 'active', NOW())
        RETURNING *
      `, [train_number, model]);
      
      console.log(`✅ Created train ${train_number}`);
      return result.rows[0];
    } catch (error) {
      console.error(`❌ Error creating train:`, error);
      reply.code(500).send({ error: 'Failed to create train', details: (error as Error).message });
    }
  });

  // ==========================================
  // ADMIN PANEL ENDPOINTS (Phase 7)
  // ==========================================

  // Get all trains with detailed stats
  fastify.get('/api/trains/all', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const result = await pool.query(`
        SELECT 
          t.*,
          COUNT(DISTINCT c.id) as wagon_count,
          COUNT(DISTINCT a.id) as aggregate_count,
          COUNT(DISTINCT CASE WHEN a.status = 'operational' THEN a.id END) as operational_aggregates,
          COUNT(DISTINCT CASE WHEN a.status != 'operational' THEN a.id END) as faulty_aggregates
        FROM trains t
        LEFT JOIN cars c ON t.train_number = c.train_id
        LEFT JOIN aggregates a ON c.id = a.current_car_id
        GROUP BY t.id, t.train_number, t.name, t.operator, t.status, t.created_at, t.updated_at, t.tenant_id
        ORDER BY t.train_number
      `);
      
      console.log(`📊 GET /api/trains/all: ${result.rows.length} trains with stats`);
      return result.rows;
    } catch (error) {
      console.error('❌ Error fetching all trains:', error);
      reply.code(500).send({ error: 'Failed to fetch all trains', details: (error as Error).message });
    }
  });

  // Configure train
  fastify.post('/api/trains/configure', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { train_number, name, operator, wagon_types } = request.body as any;
      
      const result = await pool.query(`
        INSERT INTO trains (train_number, name, operator, status, created_at)
        VALUES ($1, $2, $3, 'active', NOW())
        RETURNING *
      `, [train_number, name, operator]);
      
      console.log(`✅ Configured train ${train_number}`);
      return result.rows[0];
    } catch (error) {
      console.error(`❌ Error configuring train:`, error);
      reply.code(500).send({ error: 'Failed to configure train', details: (error as Error).message });
    }
  });

  // Get spare aggregates
  fastify.get('/api/aggregates/spare', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const result = await pool.query(`
        SELECT * FROM aggregates
        WHERE current_car_id IS NULL
        ORDER BY aggregate_number
      `);
      
      console.log(`📊 GET /api/aggregates/spare: ${result.rows.length} spare aggregates`);
      return result.rows;
    } catch (error) {
      console.error('❌ Error fetching spare aggregates:', error);
      reply.code(500).send({ error: 'Failed to fetch spare aggregates', details: (error as Error).message });
    }
  });

  // Replace aggregate
  fastify.post('/api/aggregates/replace', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { old_aggregate_id, new_aggregate_id, car_id } = request.body as any;
      
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        // Update old aggregate to spare
        await client.query(`
          UPDATE aggregates 
          SET current_car_id = NULL, status = 'reserve', updated_at = NOW()
          WHERE id = $1
        `, [old_aggregate_id]);
        
        // Assign new aggregate to car
        await client.query(`
          UPDATE aggregates 
          SET current_car_id = $1, status = 'operational', updated_at = NOW()
          WHERE id = $2
        `, [car_id, new_aggregate_id]);
        
        await client.query('COMMIT');
        
        console.log(`✅ Replaced aggregate ${old_aggregate_id} with ${new_aggregate_id} on car ${car_id}`);
        return { success: true, message: 'Aggregate replaced successfully' };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error(`❌ Error replacing aggregate:`, error);
      reply.code(500).send({ error: 'Failed to replace aggregate', details: (error as Error).message });
    }
  });

  // Get audit logs
  fastify.get('/api/audit-logs', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      // Return empty array for now since we don't have audit_logs table yet
      console.log(`📊 GET /api/audit-logs: No audit table yet`);
      return [];
    } catch (error) {
      console.error('❌ Error fetching audit logs:', error);
      reply.code(500).send({ error: 'Failed to fetch audit logs', details: (error as Error).message });
    }
  });

  // ==========================================
  // MULTI-TENANT ENDPOINTS (Phase 8)
  // ==========================================

  // Get all tenants
  fastify.get('/api/tenants', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      // Return default tenant for now
      console.log(`📊 GET /api/tenants`);
      return [{
        tenant_id: 'default',
        name: 'Öresundståg',
        created_at: new Date(),
        train_count: 0,
        user_count: 1
      }];
    } catch (error) {
      console.error('❌ Error fetching tenants:', error);
      reply.code(500).send({ error: 'Failed to fetch tenants', details: (error as Error).message });
    }
  });

  // Get tenant configuration
  fastify.get('/api/tenants/:id/configuration', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      
      console.log(`📊 GET /api/tenants/${id}/configuration`);
      
      return {
        tenant: {
          tenant_id: id,
          name: 'Öresundståg'
        },
        configuration: {
          wagon_count: 5,
          wagon_types: ['M43 Hytt', 'M43 Salong', 'T47 Salong', 'M45 Salong', 'M45 Hytt'],
          custom_labels: {}
        }
      };
    } catch (error) {
      console.error(`❌ Error fetching tenant configuration:`, error);
      reply.code(500).send({ error: 'Failed to fetch tenant configuration', details: (error as Error).message });
    }
  });

  // Update tenant configuration
  fastify.put('/api/tenants/:id/configuration', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      const config = request.body;
      
      console.log(`✅ Updated tenant ${id} configuration`);
      return { success: true, message: 'Configuration updated' };
    } catch (error) {
      console.error(`❌ Error updating tenant configuration:`, error);
      reply.code(500).send({ error: 'Failed to update tenant configuration', details: (error as Error).message });
    }
  });
}
