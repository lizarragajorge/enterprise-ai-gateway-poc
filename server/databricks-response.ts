export function databricksText(content: unknown): string {
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Invalid Databricks content block.');
      }
      const block = item as Record<string, unknown>;
      if (block.type === 'reasoning') continue;
      if (block.type !== 'text' || typeof block.text !== 'string') {
        throw new Error('Unsupported Databricks content block.');
      }
      parts.push(block.text);
    }
    const output = parts.join('');
    if (output.trim()) return output;
  }
  throw new Error('Databricks returned no supported model text. No inference success claimed.');
}
