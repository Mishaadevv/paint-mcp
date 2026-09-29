import type { PaintDocument } from "./document.js";
import { OPS, type ImageResolver } from "./ops.js";
import type { Store } from "./store.js";

export interface ExecutionResult {
  op: string;
  label: string;
  summary: string;
  layer: number;
  revision: number;
}

export const OP_NAMES = Object.keys(OPS);

function describeZodError(name: string, issues: { path: (string | number)[]; message: string }[]): string {
  const lines = issues.slice(0, 6).map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return `Invalid parameters for "${name}":\n${lines.join("\n")}\nRun paint_help topic:'ops' for the accepted fields.`;
}

function touchedLayer(params: Record<string, unknown>, doc: PaintDocument): number {
  const index = typeof params.layer === "number" ? params.layer : doc.activeIndex;
  return Math.max(0, Math.min(doc.layers.length - 1, index));
}

/**
 * Validate → snapshot → apply → commit. Every mutation, single or batched, runs
 * through here so undo history and the vector log stay consistent.
 */
export function executeOp(
  store: Store,
  doc: PaintDocument,
  name: string,
  params: Record<string, unknown>,
  resolve: ImageResolver,
): ExecutionResult {
  const definition = OPS[name];
  if (!definition) {
    throw new Error(`Unknown op "${name}". Available: ${OP_NAMES.join(", ")}`);
  }
  const parsed = definition.schema.safeParse(params);
  if (!parsed.success) {
    throw new Error(describeZodError(name, parsed.error.issues as { path: (string | number)[]; message: string }[]));
  }
  const values = parsed.data as Record<string, unknown>;
  const layer = touchedLayer(values, doc);
  const before = doc.begin(name, definition.scope === "all" ? "all" : [layer]);
  const summary = definition.apply({ doc, resolve }, values);
  doc.commit(before);
  doc.opLog.push({ op: name, params: values, layer });
  if (store.autoSave) store.saveDocument(doc);
  return { op: name, label: name, summary, layer, revision: doc.revision };
}

export function opDescription(name: string): string {
  const definition = OPS[name];
  if (!definition) return "";
  return definition.description;
}
