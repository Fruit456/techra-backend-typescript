import { FastifyInstance } from 'fastify';
import { pool } from './database-pool';

// Admin routes for Phase 7
export function registerAdminRoutes(fastify: FastifyInstance, authenticate: any) {
  
  // Get all trains with detailed stats
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
      
      return result.rows;
    } catch (error) {
      console.error('Error fetching all trains:', error);
      reply.code(500).send({ error: 'Failed to fetch trains' });
    }
  });

  // Custom wagon configuration for train
  fastify.post('/api/trains/configure', { preHandler: authenticate }, async (request: any, reply) => {
    const { train_number, name, wagon_types, operator } = request.body;
    const tenantId = request.user?.tenantId || 'default';
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create train
      const trainResult = await client.query(
        'INSERT INTO trains (train_number, name, operator, tenant_id) VALUES ($1, $2, $3, $4) RETURNING *',
        [train_number, name, operator || 'Öresundståg', tenantId]
      );
      const train = trainResult.rows[0];
      
      // Create wagons based on provided configuration
      for (let i = 0; i < wagon_types.length; i++) {
        await client.query(
          'INSERT INTO wagons (train_id, wagon_number, wagon_type, position) VALUES ($1, $2, $3, $4)',
          [train.id, i + 1, wagon_types[i], i + 1]
        );
      }
      
      // Log action
      await client.query(
        `INSERT INTO audit_logs (tenant_id, user_email, user_name, action, entity_type, entity_id, new_value, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          request.user?.email,
          request.user?.name,
          'CREATE',
          'train',
          train.id.toString(),
          JSON.stringify({ train_number, wagon_types }),
          `Created train ${train_number} with ${wagon_types.length} wagons`
        ]
      );
      
      await client.query('COMMIT');
      console.log(`✅ Created train ${train_number} with custom configuration`);
      return train;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error creating configured train:', error);
      reply.code(500).send({ error: 'Failed to create train' });
    } finally {
      client.release();
    }
  });

  // Get spare aggregates
  fastify.get('/api/aggregates/spare', { preHandler: authenticate }, async (request, reply) => {
    try {
      const result = await pool.query(`
        SELECT a.*
        FROM aggregates a
        WHERE a.is_spare = true AND a.current_wagon_id IS NULL
        ORDER BY a.aggregate_number
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
      
      // Get old aggregate info
      const oldAgg = await client.query(
        'SELECT * FROM aggregates WHERE id = $1',
        [old_aggregate_id]
      );
      
      if (oldAgg.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Old aggregate not found' });
      }
      
      const wagonId = oldAgg.rows[0].current_wagon_id;
      
      // Mark old aggregate as spare and remove from wagon
      await client.query(
        'UPDATE aggregates SET current_wagon_id = NULL, is_spare = true, status = $1 WHERE id = $2',
        ['maintenance', old_aggregate_id]
      );
      
      // Assign new aggregate to wagon
      await client.query(
        'UPDATE aggregates SET current_wagon_id = $1, is_spare = false, status = $2 WHERE id = $3',
        [wagonId, 'operational', new_aggregate_id]
      );
      
      // Log replacement
      await client.query(
        `INSERT INTO aggregate_replacements (tenant_id, old_aggregate_id, new_aggregate_id, wagon_id, reason, replaced_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, old_aggregate_id, new_aggregate_id, wagonId, reason, request.user?.email]
      );
      
      // Audit log
      await client.query(
        `INSERT INTO audit_logs (tenant_id, user_email, user_name, action, entity_type, entity_id, old_value, new_value, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          request.user?.email,
          request.user?.name,
          'REPLACE',
          'aggregate',
          old_aggregate_id.toString(),
          JSON.stringify({ aggregate_id: old_aggregate_id, wagon_id: wagonId }),
          JSON.stringify({ aggregate_id: new_aggregate_id, wagon_id: wagonId }),
          `Replaced aggregate ${oldAgg.rows[0].aggregate_number} with spare. Reason: ${reason}`
        ]
      );
      
      await client.query('COMMIT');
      console.log(`✅ Replaced aggregate ${old_aggregate_id} with ${new_aggregate_id}`);
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
        SELECT *
        FROM audit_logs
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

  // Get tenant configuration
  fastify.get('/api/tenants/:id/configuration', { preHandler: authenticate }, async (request: any, reply) => {
    try {
      const { id } = request.params;
      
      const tenantResult = await pool.query(
        'SELECT * FROM tenants WHERE tenant_id = $1',
        [id]
      );
      
      if (tenantResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }
      
      const configResult = await pool.query(
        'SELECT * FROM train_configurations WHERE tenant_id = $1',
        [id]
      );
      
      return {
        tenant: tenantResult.rows[0],
        configuration: configResult.rows[0] || null
      };
    } catch (error) {
      console.error('Error fetching tenant configuration:', error);
      reply.code(500).send({ error: 'Failed to fetch configuration' });
    }
  });

  // Update tenant configuration
  fastify.put('/api/tenants/:id/configuration', { preHandler: authenticate }, async (request: any, reply) => {
    const { id } = request.params;
    const { name, logo_url, primary_color, language, wagon_count, wagon_types, custom_labels } = request.body;
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Update tenant
      await client.query(
        `UPDATE tenants 
         SET name = COALESCE($1, name),
             logo_url = COALESCE($2, logo_url),
             primary_color = COALESCE($3, primary_color),
             language = COALESCE($4, language),
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $5`,
        [name, logo_url, primary_color, language, id]
      );
      
      // Update or insert configuration
      await client.query(
        `INSERT INTO train_configurations (tenant_id, wagon_count, wagon_types, custom_labels)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) 
         DO UPDATE SET 
           wagon_count = COALESCE($2, train_configurations.wagon_count),
           wagon_types = COALESCE($3, train_configurations.wagon_types),
           custom_labels = COALESCE($4, train_configurations.custom_labels),
           updated_at = CURRENT_TIMESTAMP`,
        [id, wagon_count, wagon_types ? JSON.stringify(wagon_types) : null, custom_labels ? JSON.stringify(custom_labels) : null]
      );
      
      // Audit log
      await client.query(
        `INSERT INTO audit_logs (tenant_id, user_email, user_name, action, entity_type, entity_id, new_value, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          request.user?.email,
          request.user?.name,
          'UPDATE',
          'tenant_config',
          id,
          JSON.stringify({ name, wagon_count, wagon_types }),
          `Updated tenant configuration for ${id}`
        ]
      );
      
      await client.query('COMMIT');
      console.log(`✅ Updated configuration for tenant ${id}`);
      return { success: true, message: 'Configuration updated' };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating tenant configuration:', error);
      reply.code(500).send({ error: 'Failed to update configuration' });
    } finally {
      client.release();
    }
  });

  // Get all tenants
  fastify.get('/api/tenants', { preHandler: authenticate }, async (request, reply) => {
    try {
      const result = await pool.query(`
        SELECT t.*, tc.wagon_count, tc.wagon_types
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
}
