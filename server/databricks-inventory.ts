export function inventory(value: unknown, field: string): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Databricks ${field} inventory.`);
  }
  const response = value as Record<string, unknown>;
  if (Object.keys(response).length === 0) return [];
  if (!Object.hasOwn(response, field) || !Array.isArray(response[field])) {
    throw new Error(`Invalid Databricks ${field} inventory.`);
  }
  return response[field];
}
