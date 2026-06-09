/**
 * Strict mode conversion for JSON Schemas (Algorithm A23).
 */

import { deepCopy } from '../utils/index.js';

export function toStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result = deepCopy(schema);
  stripExtensions(result);
  convertToStrict(result);
  return result;
}

export function applyLlmDescriptions(node: unknown): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;

  const obj = node as Record<string, unknown>;
  // Only substitute when a description already exists; never inject a
  // description onto a node that lacked one (Python/Rust parity — avoids
  // fabricating descriptions the spec did not declare).
  if ('x-llm-description' in obj && 'description' in obj) {
    obj['description'] = obj['x-llm-description'];
  }

  if ('properties' in obj && typeof obj['properties'] === 'object' && obj['properties'] !== null) {
    for (const prop of Object.values(obj['properties'] as Record<string, unknown>)) {
      applyLlmDescriptions(prop);
    }
  }
  if ('items' in obj && typeof obj['items'] === 'object') {
    applyLlmDescriptions(obj['items']);
  }
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    if (keyword in obj && Array.isArray(obj[keyword])) {
      for (const sub of obj[keyword] as unknown[]) {
        applyLlmDescriptions(sub);
      }
    }
  }
  for (const defsKey of ['definitions', '$defs']) {
    if (defsKey in obj && typeof obj[defsKey] === 'object' && obj[defsKey] !== null) {
      for (const defn of Object.values(obj[defsKey] as Record<string, unknown>)) {
        applyLlmDescriptions(defn);
      }
    }
  }
}

export function stripExtensions(node: unknown, stripDefaults: boolean = true): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;

  const obj = node as Record<string, unknown>;
  const keysToRemove = Object.keys(obj).filter(
    (k) => (typeof k === 'string' && k.startsWith('x-')) || (stripDefaults && k === 'default'),
  );
  for (const k of keysToRemove) {
    delete obj[k];
  }

  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            stripExtensions(item, stripDefaults);
          }
        }
      } else {
        stripExtensions(value, stripDefaults);
      }
    }
  }
}

function convertToStrict(node: unknown): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;

  const obj = node as Record<string, unknown>;

  if (obj['type'] === 'object' && 'properties' in obj) {
    obj['additionalProperties'] = false;
    const existingRequired = new Set(
      Array.isArray(obj['required']) ? (obj['required'] as string[]) : [],
    );
    const properties = obj['properties'] as Record<string, unknown>;
    const allNames = Object.keys(properties);
    const optionalNames = allNames.filter((n) => !existingRequired.has(n));

    for (const name of optionalNames) {
      const prop = properties[name] as Record<string, unknown>;
      if ('type' in prop) {
        if (typeof prop['type'] === 'string') {
          prop['type'] = [prop['type'], 'null'];
        } else if (Array.isArray(prop['type'])) {
          if (!(prop['type'] as string[]).includes('null')) {
            (prop['type'] as string[]).push('null');
          }
        }
      } else if ('oneOf' in prop && Array.isArray(prop['oneOf'])) {
        const variants = prop['oneOf'] as Record<string, unknown>[];
        if (!variants.some((v) => v['type'] === 'null')) {
          variants.push({ type: 'null' });
        }
      } else if ('anyOf' in prop && Array.isArray(prop['anyOf'])) {
        const variants = prop['anyOf'] as Record<string, unknown>[];
        if (!variants.some((v) => v['type'] === 'null')) {
          variants.push({ type: 'null' });
        }
      } else {
        properties[name] = { oneOf: [prop, { type: 'null' }] };
      }
    }

    obj['required'] = [...allNames].sort();
  }

  if ('properties' in obj && typeof obj['properties'] === 'object' && obj['properties'] !== null) {
    for (const prop of Object.values(obj['properties'] as Record<string, unknown>)) {
      convertToStrict(prop);
    }
  }
  if ('items' in obj && typeof obj['items'] === 'object') {
    convertToStrict(obj['items']);
  }
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    if (keyword in obj && Array.isArray(obj[keyword])) {
      for (const sub of obj[keyword] as unknown[]) {
        convertToStrict(sub);
      }
    }
  }
  for (const defsKey of ['definitions', '$defs']) {
    if (defsKey in obj && typeof obj[defsKey] === 'object' && obj[defsKey] !== null) {
      for (const defn of Object.values(obj[defsKey] as Record<string, unknown>)) {
        convertToStrict(defn);
      }
    }
  }
}
