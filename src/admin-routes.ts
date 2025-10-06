import { FastifyInstance } from 'fastify';
import { pool } from './database-pool';

/**
 * Register all admin and database-related routes
 * All routes use multi-tenant filtering via request.user.tenantId
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
        SELECT t.*, COUNT(w.id) as wagon_count 
        FROM trains t
        LEFT JOIN wagons w ON t.id = w.train_id
        WHERE t.tenant_id = $1
        GROUP BY t.id
        ORDER BY t.train_number
      `, [tenantId]);
      
      console.log(`📊 GET /api/trains: ${result.rows.length} trains for tenant ${tenantId}`);
      return result.rows;
    } catch (error) {
      console.error('Error fetching trains:', error);
      reply.code(500).send({ error: 'Failed to fetch trains' });
    }
  });

  // Get single train with wagons
  fastify.get('/api/trains/:id', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      const tenantId = request.user?.tenantId || 'default';
      
      const trainResult = await pool.query(
        'SELECT * FROM trains WHERE id = $1 AND tenant_id = $2',
        [id, tenantId]
      );
      
      if (trainResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Train not found' });
      }
      
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

  // Get all aggregates
  fastify.get('/api/aggregates', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const tenantId = request.user?.tenantId || 'default';
      
      const result = await pool.query(`
        SELECT a.*, w.wagon_number, w.wagon_type, t.train_number
        FROM aggregates a
        LEFT JOIN wagons w ON a.current_wagon_id = w.id
        LEFT JOIN trains t ON w.train_id = t.id
        WHERE t.tenant_id = $1 OR a.is_spare = true
        ORDER BY a.aggregate_number
      `, [tenantId]);
      
      console.log(`📊 GET /api/aggregates: ${result.rows.length} aggregates for tenant ${tenantId}`);
      return result.rows;
    } catch (error) {
      console.error('Error fetching aggregates:', error);
      reply.code(500).send({ error: 'Failed to fetch aggregates' });
    }
  });

  // ==========================================
  // ADMIN PANEL ENDPOINTS (Phase 7)
  // ==========================================

  // Get all trains with detailed stats (used by Admin Panel)
  fastify.get('/api/trains/all', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const tenantId = request.user?.tenantId || 'default';
      
      const result = await pool.query(`
        SELECT 
          t.*,
          COUNT(DISTINCT w.id) as wagon_count,
          COUNT(DISTINCT a.id) as aggregate_count,
          COUNT(DISTINCT CASE WHEN a.status = 'operational' THEN a.id END) as operational_aggregates,
          COUNT(DISTINCT CASE WHEN a.status != 'operational' THEN a.id END) as faulty_aggregates
        FROM trains t
        LEFT JOIN wagons w ON t.id = w.train_id
        LEFT JOIN aggregates a ON w.id = a.current_wagon_id
        WHERE t.tenant_id = $1
        GROUP BY t.id
        ORDER BY t.train_number
      `, [tenantId]);
      
      console.log(`📊 GET /api/trains/all: ${result.rows.length} trains with stats for tenant ${tenantId}`);
      return result.rows;
    } catch (error) {
      console.error('Error fetching all trains:', error);
      reply.code(500).send({ error: 'Failed to fetch trains' });
    }
  });

  // Configure a new train with custom wagon layout
  fastify.post('/api/trains/configure', { preHandler: authenticate }, async (request: any, reply) => {
    const { train_number, name, wagon_types, operator } = request.body;
    const tenantId = request.user?.tenantId || 'default';
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create train
      const trainResult = await client.query(
        `INSERT INTO trains (train_number, name, operator, status, tenant_id)
         VALUES ($1, $2, $3, 'operational', $4)
         RETURNING *`,
        [train_number, name, operator || 'Öresundståg', tenantId]
      );
      const train = trainResult.rows[0];
      
      // Create wagons based on configuration
      for (let i = 0; i < wagon_types.length; i++) {
        await client.query(
          `INSERT INTO wagons (train_id, wagon_number, wagon_type, position, status)
           VALUES ($1, $2, $3, $4, 'operational')`,
          [train.id, `${train_number}-${i + 1}`, wagon_types[i], i + 1]
        );
      }
      
      // Log the action
      await client.query(
        `INSERT INTO audit_logs (tenant_id, user_email, user_name, action, entity_type, entity_id, description)
         VALUES ($1, $2, $3, 'CREATE', 'train', $4, $5)`,
        [tenantId, request.user?.email, request.user?.name, train.id.toString(), 
         `Created train ${train_number} with ${wagon_types.length} wagons`]
      );
      
      await client.query('COMMIT');
      console.log(`✅ Created train ${train_number} for tenant ${tenantId}`);
      return train;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error configuring train:', error);
      reply.code(500).send({ error: 'Failed to configure train' });
    } finally {
      client.release();
    }
  });

  // Get spare aggregates
  fastify.get('/api/aggregates/spare', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const result = await pool.query(`
        SELECT * FROM aggregates
        WHERE is_spare = true
        ORDER BY aggregate_number
      `);
      
      return result.rows;
    } catch (error) {
      console.error('Error fetching spare aggregates:', error);
      reply.code(500).send({ error: 'Failed to fetch spare aggregates' });
    }
  });

  // Replace broken aggregate with spare
  fastify.post('/api/aggregates/replace', { preHandler: authenticate }, async (request: any, reply) => {
    const { old_aggregate_id, new_aggregate_id, reason } = request.body;
    const tenantId = request.user?.tenantId || 'default';
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get current wagon of old aggregate
      const oldAggResult = await client.query(
        'SELECT current_wagon_id FROM aggregates WHERE id = $1',
        [old_aggregate_id]
      );
      
      if (oldAggResult.rows.length === 0) {
        throw new Error('Old aggregate not found');
      }
      
      const wagonId = oldAggResult.rows[0].current_wagon_id;
      
      // Mark old aggregate as spare and remove from wagon
      await client.query(
        `UPDATE aggregates 
         SET is_spare = true, current_wagon_id = NULL, status = 'maintenance'
         WHERE id = $1`,
        [old_aggregate_id]
      );
      
      // Assign new aggregate to wagon
      await client.query(
        `UPDATE aggregates 
         SET is_spare = false, current_wagon_id = $1, status = 'operational'
         WHERE id = $2`,
        [wagonId, new_aggregate_id]
      );
      
      // Log the replacement
      await client.query(
        `INSERT INTO aggregate_replacements (tenant_id, old_aggregate_id, new_aggregate_id, wagon_id, reason, replaced_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, old_aggregate_id, new_aggregate_id, wagonId, reason, request.user?.email]
      );
      
      await client.query(
        `INSERT INTO audit_logs (tenant_id, user_email, user_name, action, entity_type, entity_id, description)
         VALUES ($1, $2, $3, 'REPLACE', 'aggregate', $4, $5)`,
        [tenantId, request.user?.email, request.user?.name, new_aggregate_id.toString(), 
         `Replaced aggregate ${old_aggregate_id} with ${new_aggregate_id}: ${reason}`]
      );
      
      await client.query('COMMIT');
      return { success: true, message: 'Aggregate replaced successfully' };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error replacing aggregate:', error);
      reply.code(500).send({ error: 'Failed to replace aggregate' });
    } finally {
      client.release();
    }
  });

  // Get audit logs
  fastify.get('/api/audit-logs', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const tenantId = request.user?.tenantId || 'default';
      const { limit = 100, offset = 0 } = request.query as any;

      const result = await pool.query(`
        SELECT * FROM audit_logs
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [tenantId, limit, offset]);
      
      return result.rows;
    } catch (error) {
      console.error('Error fetching audit logs:', error);
      reply.code(500).send({ error: 'Failed to fetch audit logs' });
    }
  });

  // ==========================================
  // MULTI-TENANT ENDPOINTS (Phase 8)
  // ==========================================

  // Get all tenants (admin only)
  fastify.get('/api/tenants', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const result = await pool.query(`
        SELECT t.*, tc.wagon_count, tc.wagon_types, tc.custom_labels
        FROM tenants t
        LEFT JOIN train_configurations tc ON t.tenant_id = tc.tenant_id
        ORDER BY t.name
      `);
      
      return result.rows;
    } catch (error) {
      console.error('Error fetching tenants:', error);
      reply.code(500).send({ error: 'Failed to fetch tenants' });
    }
  });

  // Get tenant configuration
  fastify.get('/api/tenants/:tenant_id/configuration', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { tenant_id } = request.params;
      
      const result = await pool.query(`
        SELECT t.*, tc.wagon_count, tc.wagon_types, tc.custom_labels
        FROM tenants t
        LEFT JOIN train_configurations tc ON t.tenant_id = tc.tenant_id
        WHERE t.tenant_id = $1
      `, [tenant_id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }
      
      return result.rows[0];
    } catch (error) {
      console.error('Error fetching tenant configuration:', error);
      reply.code(500).send({ error: 'Failed to fetch tenant configuration' });
    }
  });

  // Update tenant configuration
  fastify.put('/api/tenants/:tenant_id/configuration', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { tenant_id } = request.params;
      const { wagon_count, wagon_types, custom_labels, primary_color, logo_url } = request.body;
      const client = await pool.connect();
      
      await client.query('BEGIN');
      
      // Update tenant
      await client.query(
        `UPDATE tenants 
         SET primary_color = COALESCE($1, primary_color),
             logo_url = COALESCE($2, logo_url),
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $3`,
        [primary_color, logo_url, tenant_id]
      );
      
      // Update configuration
      await client.query(
        `INSERT INTO train_configurations (tenant_id, wagon_count, wagon_types, custom_labels)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET
           wagon_count = EXCLUDED.wagon_count,
           wagon_types = EXCLUDED.wagon_types,
           custom_labels = EXCLUDED.custom_labels,
           updated_at = CURRENT_TIMESTAMP`,
        [tenant_id, wagon_count, JSON.stringify(wagon_types), JSON.stringify(custom_labels)]
      );
      
      await client.query('COMMIT');
      client.release();
      
      return { success: true, message: 'Tenant configuration updated' };
    } catch (error) {
      console.error('Error updating tenant configuration:', error);
      reply.code(500).send({ error: 'Failed to update tenant configuration' });
    }
  });
}

