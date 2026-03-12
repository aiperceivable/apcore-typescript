/**
 * Schema type definitions and data structures for the apcore schema system.
 */

import type { TSchema } from '@sinclair/typebox';
import { SchemaValidationError } from '../errors.js';

export enum SchemaStrategy {
  YamlFirst = 'yaml_first',
  NativeFirst = 'native_first',
  YamlOnly = 'yaml_only',
}

export enum ExportProfile {
  MCP = 'mcp',
  OpenAI = 'openai',
  Anthropic = 'anthropic',
  Generic = 'generic',
}

export interface SchemaDefinition {
  moduleId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  errorSchema?: Record<string, unknown> | null;
  definitions: Record<string, unknown>;
  version: string;
  documentation?: string | null;
  schemaUrl?: string | null;
}

export interface ResolvedSchema {
  jsonSchema: Record<string, unknown>;
  schema: TSchema;
  moduleId: string;
  direction: string;
}

export interface SchemaValidationErrorDetail {
  path: string;
  message: string;
  constraint?: string | null;
  expected?: unknown;
  actual?: unknown;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationErrorDetail[];
}

export function validationResultToError(result: SchemaValidationResult): SchemaValidationError {
  if (result.valid) {
    throw new Error('Cannot convert valid result to error');
  }
  const errorDicts = result.errors.map((e) => ({
    path: e.path,
    message: e.message,
    constraint: e.constraint ?? null,
    expected: e.expected ?? null,
    actual: e.actual ?? null,
  }));
  return new SchemaValidationError('Schema validation failed', errorDicts);
}

export interface LLMExtensions {
  llmDescription?: string | null;
  examples?: unknown[] | null;
  sensitive: boolean;
  constraints?: string | null;
  deprecated?: Record<string, unknown> | null;
  sunsetDate?: string | null;
}
