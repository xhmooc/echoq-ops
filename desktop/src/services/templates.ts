/** M3 自定义出图模板：编辑器 schema 存 custom_templates 表，渲染侧按 schema 出图。 */
import { now } from "../core/config";
import { execute, queryAll, queryOne } from "../core/db";

export interface CustomTemplateRecord {
  id: number;
  name: string;
  schema: string;
  preview: string;
  created_at: number;
  updated_at: number;
}

interface TemplateRow {
  id: number;
  name: string;
  schema: string;
  preview: string;
  created_at: number;
  updated_at: number;
}

function serialize(row: TemplateRow): Record<string, unknown> {
  let schema: unknown = {};
  try {
    schema = JSON.parse(row.schema || "{}");
  } catch {
    schema = {};
  }
  return {
    id: row.id,
    name: row.name,
    schema,
    preview: row.preview || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTemplates(): Record<string, unknown>[] {
  const rows = queryAll<TemplateRow>(
    "SELECT * FROM custom_templates ORDER BY updated_at DESC, id DESC"
  );
  return rows.map(serialize);
}

export function getTemplate(id: number): Record<string, unknown> | null {
  const row = queryOne<TemplateRow>("SELECT * FROM custom_templates WHERE id = ?", id);
  return row ? serialize(row) : null;
}

export function createTemplate(input: {
  name: string;
  schema: unknown;
  preview?: string;
}): Record<string, unknown> {
  const ts = now();
  const schemaText = JSON.stringify(input.schema ?? {});
  const id = execute(
    "INSERT INTO custom_templates (name, schema, preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    String(input.name || "未命名模板").slice(0, 80),
    schemaText,
    String(input.preview || ""),
    ts,
    ts
  );
  return getTemplate(id) as Record<string, unknown>;
}

export function updateTemplate(
  id: number,
  input: { name?: string; schema?: unknown; preview?: string }
): Record<string, unknown> | null {
  const row = queryOne<TemplateRow>("SELECT * FROM custom_templates WHERE id = ?", id);
  if (!row) return null;
  const name = input.name !== undefined ? String(input.name).slice(0, 80) : row.name;
  const schema = input.schema !== undefined ? JSON.stringify(input.schema) : row.schema;
  const preview = input.preview !== undefined ? String(input.preview) : row.preview;
  execute(
    "UPDATE custom_templates SET name = ?, schema = ?, preview = ?, updated_at = ? WHERE id = ?",
    name,
    schema,
    preview,
    now(),
    id
  );
  return getTemplate(id);
}

export function deleteTemplate(id: number): boolean {
  const row = queryOne<TemplateRow>("SELECT id FROM custom_templates WHERE id = ?", id);
  if (!row) return false;
  execute("DELETE FROM custom_templates WHERE id = ?", id);
  return true;
}

export function duplicateTemplate(id: number): Record<string, unknown> | null {
  const row = queryOne<TemplateRow>("SELECT * FROM custom_templates WHERE id = ?", id);
  if (!row) return null;
  const ts = now();
  const newId = execute(
    "INSERT INTO custom_templates (name, schema, preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    `${row.name} 副本`.slice(0, 80),
    row.schema,
    row.preview,
    ts,
    ts
  );
  return getTemplate(newId);
}
