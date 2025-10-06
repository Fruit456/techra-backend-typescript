/**
 * Tenant Mapping
 * Maps Azure AD Tenant IDs to database tenant_ids
 */

export interface TenantMapping {
  azureTenantId: string;
  dbTenantId: string;
  name: string;
}

// Default mapping - can be overridden by environment variable
const DEFAULT_TENANT_MAPPINGS: TenantMapping[] = [
  {
    azureTenantId: '71416bf2-04a4-4715-a8d2-6af239168e20',
    dbTenantId: 'default',
    name: 'Öresundståg'
  }
];

// Parse tenant mappings from environment variable or use defaults
// Format: TENANT_MAPPING='[{"azureTenantId":"xxx","dbTenantId":"yyy","name":"zzz"}]'
let tenantMappings: TenantMapping[] = DEFAULT_TENANT_MAPPINGS;

try {
  const envMapping = process.env.TENANT_MAPPING;
  if (envMapping) {
    tenantMappings = JSON.parse(envMapping);
    console.log('✅ Loaded tenant mappings from environment:', tenantMappings.length);
  } else {
    console.log('✅ Using default tenant mapping (Öresundståg)');
  }
} catch (error) {
  console.warn('⚠️ Failed to parse TENANT_MAPPING env var, using defaults:', error);
}

/**
 * Get database tenant_id from Azure AD tenant_id
 * @param azureTenantId - Azure AD tenant ID from JWT token
 * @returns Database tenant_id or 'default'
 */
export function getDbTenantId(azureTenantId: string): string {
  const mapping = tenantMappings.find(m => m.azureTenantId === azureTenantId);
  
  if (mapping) {
    return mapping.dbTenantId;
  }
  
  // Fallback to 'default' for unknown tenants
  console.warn(`⚠️ No tenant mapping found for Azure tenant: ${azureTenantId}, using 'default'`);
  return 'default';
}

/**
 * Get tenant name from database tenant_id
 * @param dbTenantId - Database tenant ID
 * @returns Tenant name or 'Unknown'
 */
export function getTenantName(dbTenantId: string): string {
  const mapping = tenantMappings.find(m => m.dbTenantId === dbTenantId);
  return mapping?.name || 'Unknown';
}

/**
 * Get all configured tenants
 * @returns Array of tenant mappings
 */
export function getAllTenants(): TenantMapping[] {
  return tenantMappings;
}

/**
 * Add a new tenant mapping (for dynamic configuration)
 * @param mapping - Tenant mapping to add
 */
export function addTenantMapping(mapping: TenantMapping): void {
  // Check if mapping already exists
  const existingIndex = tenantMappings.findIndex(
    m => m.azureTenantId === mapping.azureTenantId
  );
  
  if (existingIndex >= 0) {
    // Update existing
    tenantMappings[existingIndex] = mapping;
    console.log(`✅ Updated tenant mapping: ${mapping.name}`);
  } else {
    // Add new
    tenantMappings.push(mapping);
    console.log(`✅ Added tenant mapping: ${mapping.name}`);
  }
}

export default {
  getDbTenantId,
  getTenantName,
  getAllTenants,
  addTenantMapping
};

