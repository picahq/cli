import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Flow, FlowStep, FlowStepType, FlowOutputSchema } from './flow-types.js';
import { FLOW_SCHEMA, getStepTypeDescriptor, getNestedStepsKeys } from './flow-schema.js';

export interface ValidationError {
  path: string;
  message: string;
}

export function validateFlowSchema(flow: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!flow || typeof flow !== 'object') {
    errors.push({ path: '', message: 'Flow must be a JSON object' });
    return errors;
  }

  const f = flow as Record<string, unknown>;

  // ── Top-level flow fields ──

  if (!f.key || typeof f.key !== 'string') {
    errors.push({ path: 'key', message: 'Flow must have a string "key"' });
  } else if (FLOW_SCHEMA.flowFields.key.pattern && !FLOW_SCHEMA.flowFields.key.pattern.test(f.key) && f.key.length > 1) {
    errors.push({ path: 'key', message: 'Flow key must be kebab-case (lowercase letters, numbers, hyphens)' });
  }

  if (!f.name || typeof f.name !== 'string') {
    errors.push({ path: 'name', message: 'Flow must have a string "name"' });
  }

  if (f.description !== undefined && typeof f.description !== 'string') {
    errors.push({ path: 'description', message: '"description" must be a string' });
  }

  if (f.version !== undefined && typeof f.version !== 'string') {
    errors.push({ path: 'version', message: '"version" must be a string' });
  }

  // ── Validate inputs ──

  if (!f.inputs || typeof f.inputs !== 'object' || Array.isArray(f.inputs)) {
    errors.push({ path: 'inputs', message: 'Flow must have an "inputs" object' });
  } else {
    const inputs = f.inputs as Record<string, unknown>;
    for (const [name, decl] of Object.entries(inputs)) {
      const prefix = `inputs.${name}`;
      if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
        errors.push({ path: prefix, message: 'Input declaration must be an object' });
        continue;
      }
      const d = decl as Record<string, unknown>;
      if (!d.type || !FLOW_SCHEMA.validInputTypes.includes(d.type as string)) {
        errors.push({ path: `${prefix}.type`, message: `Input type must be one of: ${FLOW_SCHEMA.validInputTypes.join(', ')}` });
      }
      if (d.enum !== undefined) {
        if (!Array.isArray(d.enum) || d.enum.length === 0) {
          errors.push({ path: `${prefix}.enum`, message: '"enum" must be a non-empty array of allowed values' });
        }
      }
      if (d.connection !== undefined) {
        if (!d.connection || typeof d.connection !== 'object') {
          errors.push({ path: `${prefix}.connection`, message: 'Connection metadata must be an object' });
        } else {
          const conn = d.connection as Record<string, unknown>;
          if (!conn.platform || typeof conn.platform !== 'string') {
            errors.push({ path: `${prefix}.connection.platform`, message: 'Connection must have a string "platform"' });
          }
        }
      }
    }
  }

  // ── Validate steps ──

  if (!Array.isArray(f.steps)) {
    errors.push({ path: 'steps', message: 'Flow must have a "steps" array' });
  } else {
    validateStepsArray(f.steps as unknown[], 'steps', errors);
  }

  return errors;
}

// ── Step validation (descriptor-driven) ──

function validateStepsArray(steps: unknown[], pathPrefix: string, errors: ValidationError[]): void {
  const validTypes = FLOW_SCHEMA.stepTypes.map(st => st.type);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const path = `${pathPrefix}[${i}]`;

    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push({ path, message: 'Step must be an object' });
      continue;
    }

    const s = step as Record<string, unknown>;

    // Common fields
    if (!s.id || typeof s.id !== 'string') {
      errors.push({ path: `${path}.id`, message: 'Step must have a string "id"' });
    }
    if (!s.name || typeof s.name !== 'string') {
      errors.push({ path: `${path}.name`, message: 'Step must have a string "name"' });
    }
    if (!s.type || !validTypes.includes(s.type as FlowStepType)) {
      errors.push({ path: `${path}.type`, message: `Step type must be one of: ${validTypes.join(', ')}` });
      continue; // can't validate type-specific config without a valid type
    }

    // requires validation: must be an array of $.x.y.z selector strings
    if (s.requires !== undefined) {
      if (!Array.isArray(s.requires)) {
        errors.push({ path: `${path}.requires`, message: '"requires" must be an array of selector strings (e.g. ["$.steps.foo.output.bar"])' });
      } else {
        for (let r = 0; r < s.requires.length; r++) {
          const sel = s.requires[r];
          if (typeof sel !== 'string') {
            errors.push({ path: `${path}.requires[${r}]`, message: '"requires" entry must be a selector string' });
          } else if (!sel.startsWith('$.')) {
            errors.push({ path: `${path}.requires[${r}]`, message: `"requires" entry "${sel}" must be a selector starting with "$." (e.g. "$.steps.foo.output.bar")` });
          }
        }
      }
    }

    // onError validation
    if (s.onError && typeof s.onError === 'object') {
      const oe = s.onError as Record<string, unknown>;
      if (!FLOW_SCHEMA.errorStrategies.includes(oe.strategy as string)) {
        errors.push({ path: `${path}.onError.strategy`, message: `Error strategy must be one of: ${FLOW_SCHEMA.errorStrategies.join(', ')}` });
      }
    }

    // Type-specific validation
    const descriptor = getStepTypeDescriptor(s.type as string);
    if (!descriptor) continue;

    const configKey = descriptor.configKey;
    const configObj = s[configKey];

    if (!configObj || typeof configObj !== 'object') {
      // Detect common mistake: flat config fields on the step
      const hint = detectFlatConfigHint(s, descriptor);
      errors.push({
        path: `${path}.${configKey}`,
        message: `${capitalize(descriptor.type)} step must have a "${configKey}" config object${hint}`,
      });
      continue;
    }

    const config = configObj as Record<string, unknown>;

    // Validate each field in the descriptor
    for (const [fieldName, fd] of Object.entries(descriptor.fields)) {
      const fieldPath = `${path}.${configKey}.${fieldName}`;
      const value = config[fieldName];

      if (fd.required && (value === undefined || value === null || value === '')) {
        errors.push({ path: fieldPath, message: `${capitalize(descriptor.type)} must have ${fd.type === 'string' ? 'a string' : fd.type === 'array' ? 'a' : 'a'} "${fieldName}"` });
        continue;
      }

      if (value === undefined) continue;

      // Type checks for specific field types
      if (fd.type === 'string' && fd.required && typeof value !== 'string') {
        errors.push({ path: fieldPath, message: `"${fieldName}" must be a string` });
      }
      if (fd.type === 'number' && value !== undefined && (typeof value !== 'number' || value <= 0)) {
        errors.push({ path: fieldPath, message: `${fieldName} must be a positive number` });
      }
      if (fd.type === 'boolean' && value !== undefined && typeof value !== 'boolean') {
        errors.push({ path: fieldPath, message: `${fieldName} must be a boolean` });
      }

      // Recurse into steps arrays
      if (fd.stepsArray) {
        if (!Array.isArray(value)) {
          errors.push({ path: fieldPath, message: `"${fieldName}" must be a steps array` });
        } else {
          validateStepsArray(value, fieldPath, errors);
        }
      }

      // Special: paginate.action is a nested action config
      if (descriptor.type === 'paginate' && fieldName === 'action') {
        if (typeof value === 'object' && value !== null) {
          const a = value as Record<string, unknown>;
          if (!a.platform) errors.push({ path: `${fieldPath}.platform`, message: 'Action must have "platform"' });
          if (!a.actionId) errors.push({ path: `${fieldPath}.actionId`, message: 'Action must have "actionId"' });
          if (!a.connectionKey) errors.push({ path: `${fieldPath}.connectionKey`, message: 'Action must have "connectionKey"' });
        }
      }
    }

    // Special: code step — require exactly one of source/module and validate module path
    if (descriptor.type === 'code') {
      const hasSource = typeof config.source === 'string' && (config.source as string).length > 0;
      const hasModule = typeof config.module === 'string' && (config.module as string).length > 0;
      if (!hasSource && !hasModule) {
        errors.push({ path: `${path}.${configKey}`, message: 'Code step must define either "source" (inline JS) or "module" (path to .mjs file)' });
      } else if (hasSource && hasModule) {
        errors.push({ path: `${path}.${configKey}`, message: 'Code step cannot define both "source" and "module" — pick one' });
      }
      if (hasModule) {
        const m = config.module as string;
        if (m.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(m)) {
          errors.push({ path: `${path}.${configKey}.module`, message: 'Code module path must be relative to the flow folder (no absolute paths)' });
        } else if (m.split(/[\\/]/).includes('..')) {
          errors.push({ path: `${path}.${configKey}.module`, message: 'Code module path must not escape the flow folder ("..")' });
        } else if (!m.endsWith('.mjs')) {
          errors.push({ path: `${path}.${configKey}.module`, message: 'Code module must be a .mjs file' });
        }
      }
      // Static syntax check of inline code source — catches brace/paren mismatches,
      // duplicate declarations, etc. before the flow runs.
      if (hasSource) {
        const syntaxError = checkCodeSourceSyntax(config.source as string);
        if (syntaxError) {
          errors.push({ path: `${path}.${configKey}.source`, message: `Syntax error in code step: ${syntaxError}` });
        }
      }
    }
  }
}

// ── Hint detection for common mistakes ──

function detectFlatConfigHint(step: Record<string, unknown>, descriptor: ReturnType<typeof getStepTypeDescriptor> & object): string {
  // Check if the user put config fields directly on the step
  const requiredFields = Object.entries(descriptor.fields).filter(([, fd]) => fd.required).map(([name]) => name);
  const flatFields = requiredFields.filter(f => f in step);
  if (flatFields.length > 0) {
    return `. Hint: "${flatFields.join('", "')}" must be nested inside "${descriptor.configKey}": { ... }, not placed directly on the step`;
  }
  return '';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Code step syntax check ──

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;

/**
 * Parse-check an inline code step source the same way the engine will execute
 * it (as the body of an async function with `$` and `require` in scope). The
 * Function constructor parses the body but does not run it, so this is a
 * static check — it catches syntax errors but not runtime errors.
 *
 * Returns the SyntaxError message, or null if the source parses cleanly.
 */
export function checkCodeSourceSyntax(source: string): string | null {
  try {
    new AsyncFunctionCtor('$', 'require', source);
    return null;
  } catch (err) {
    if (err instanceof SyntaxError) return err.message;
    return (err as Error).message;
  }
}

// ── Step ID uniqueness ──

export function validateStepIds(flow: Flow): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  const nestedKeys = getNestedStepsKeys();

  function collectIds(steps: FlowStep[], pathPrefix: string): void {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const path = `${pathPrefix}[${i}]`;

      if (seen.has(step.id)) {
        errors.push({ path: `${path}.id`, message: `Duplicate step ID: "${step.id}"` });
      } else {
        seen.add(step.id);
      }

      // Recurse into all nested steps arrays using the descriptor
      for (const { configKey, fieldName } of nestedKeys) {
        const config = (step as unknown as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
        if (config && Array.isArray(config[fieldName])) {
          collectIds(config[fieldName] as FlowStep[], `${path}.${configKey}.${fieldName}`);
        }
      }
    }
  }

  collectIds(flow.steps, 'steps');
  return errors;
}

// ── Selector reference validation ──

export function validateSelectorReferences(flow: Flow): ValidationError[] {
  const errors: ValidationError[] = [];
  const inputNames = new Set(Object.keys(flow.inputs));
  const nestedKeys = getNestedStepsKeys();

  function getAllStepIds(steps: FlowStep[]): Set<string> {
    const ids = new Set<string>();
    for (const step of steps) {
      ids.add(step.id);
      for (const { configKey, fieldName } of nestedKeys) {
        const config = (step as unknown as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
        if (config && Array.isArray(config[fieldName])) {
          for (const id of getAllStepIds(config[fieldName] as FlowStep[])) ids.add(id);
        }
      }
    }
    return ids;
  }

  const allStepIds = getAllStepIds(flow.steps);

  // Matches individual $.x.y.z selector tokens, stopping at operators and whitespace
  const SELECTOR_TOKEN_RE = /\$\.[a-zA-Z_][\w.\[\]*]*/g;

  function extractSelectors(value: unknown): string[] {
    const selectors: string[] = [];
    if (typeof value === 'string') {
      // Extract all $.x.y.z tokens (handles expressions like "$.input.x && $.input.y > 0")
      for (const match of value.matchAll(SELECTOR_TOKEN_RE)) {
        selectors.push(match[0]);
      }
      // Also extract from {{...}} interpolations. Stop the selector token at
      // whitespace OR a `|` so escape pipes (cli#53, e.g. `{{$.x | shell}}`)
      // and the legacy `q` prefix don't get pulled into the selector text.
      const interpolated = value.matchAll(/\{\{\s*(?:q\s+)?(\$\.[^}\s|]+)/g);
      for (const match of interpolated) {
        selectors.push(match[1]);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        selectors.push(...extractSelectors(item));
      }
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) {
        selectors.push(...extractSelectors(v));
      }
    }
    return selectors;
  }

  function checkSelectors(selectors: string[], path: string, precedingStepIds?: Set<string>): void {
    for (const selector of selectors) {
      const parts = selector.split('.');
      if (parts.length < 3) continue;

      const root = parts[1];
      if (root === 'input') {
        const inputName = parts[2];
        if (!inputNames.has(inputName)) {
          errors.push({ path, message: `Selector "${selector}" references undefined input "${inputName}"` });
        }
      } else if (root === 'steps') {
        const stepId = parts[2].replace(/[\[\]]/g, '').split(/[\[\]]/)[0];
        if (!allStepIds.has(stepId)) {
          errors.push({ path, message: `Selector "${selector}" references undefined step "${stepId}"` });
        } else if (precedingStepIds && !precedingStepIds.has(stepId)) {
          errors.push({
            path,
            message: `Selector "${selector}" references step "${stepId}" which is declared after the current step. Steps execute in declaration order, so this will always resolve to undefined at runtime — move the dependency earlier in the steps array.`,
          });
        }
      }
    }
  }

  // Fields that are evaluated as JS expressions at runtime (not dot-path selectors)
  const EXPRESSION_FIELDS = new Set(['condition.expression', 'while.condition']);

  function checkOperatorsInSelectorField(value: unknown, path: string): void {
    if (typeof value === 'string' && value.startsWith('$.')) {
      if (value.includes('||')) {
        errors.push({ path, message: `Selector "${value}" contains unsupported operator "||". Selectors in data fields use dot-path resolution, not JS evaluation. Use the "default" field on the input definition instead, or use a "code" step for complex expressions.` });
      } else if (value.includes('&&')) {
        errors.push({ path, message: `Selector "${value}" contains unsupported operator "&&". Selectors in data fields use dot-path resolution, not JS evaluation. Use a "condition" step or "code" step for complex expressions.` });
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        checkOperatorsInSelectorField(v, `${path}.${k}`);
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        checkOperatorsInSelectorField(value[i], `${path}[${i}]`);
      }
    }
  }

  function checkStep(step: FlowStep, pathPrefix: string, preceding: Set<string>): void {
    // if/unless are JS expressions — validate selector references but allow operators
    if (step.if) checkSelectors(extractSelectors(step.if), `${pathPrefix}.if`, preceding);
    if (step.unless) checkSelectors(extractSelectors(step.unless), `${pathPrefix}.unless`, preceding);

    // requires entries are pure selectors — every entry must reference a real
    // input or a preceding step (forward refs always resolve to undefined).
    if (Array.isArray((step as { requires?: unknown }).requires)) {
      const reqs = (step as { requires: unknown[] }).requires;
      reqs.forEach((sel, i) => {
        if (typeof sel === 'string' && sel.startsWith('$.')) {
          checkSelectors([sel], `${pathPrefix}.requires[${i}]`, preceding);
        }
      });
    }

    // Check selectors in all config objects
    const descriptor = getStepTypeDescriptor(step.type);
    if (descriptor) {
      const config = (step as unknown as Record<string, unknown>)[descriptor.configKey];
      if (config && typeof config === 'object') {
        if (step.type !== 'transform' && step.type !== 'code') {
          for (const [fieldName, fd] of Object.entries(descriptor.fields)) {
            if (fd.stepsArray) continue; // steps are checked recursively below
            const value = (config as Record<string, unknown>)[fieldName];
            if (value !== undefined) {
              const fieldKey = `${descriptor.configKey}.${fieldName}`;
              const fieldPath = `${pathPrefix}.${fieldKey}`;
              checkSelectors(extractSelectors(value), fieldPath, preceding);
              // For non-expression fields, detect operators that won't work at runtime
              if (!EXPRESSION_FIELDS.has(fieldKey)) {
                checkOperatorsInSelectorField(value, fieldPath);
              }
            }
          }
        } else {
          // Code/transform steps: extract $.steps.X / $.input.X tokens directly
          // from their source/expression so forward references and undefined
          // step IDs are caught at load time (cli#44).
          const c = config as Record<string, unknown>;
          const codeSource = step.type === 'code' ? (c.source as string | undefined) : undefined;
          const transformExpr = step.type === 'transform' ? (c.expression as string | undefined) : undefined;
          const text = codeSource ?? transformExpr;
          if (typeof text === 'string') {
            const fieldName = step.type === 'code' ? 'source' : 'expression';
            checkSelectors(extractSelectors(text), `${pathPrefix}.${descriptor.configKey}.${fieldName}`, preceding);
          }
        }
      }

      // Recurse into nested steps. Inside a nested array, the parent's
      // `preceding` set carries over (parent + earlier siblings) and we
      // accumulate sibling IDs as we walk.
      for (const { configKey, fieldName } of nestedKeys) {
        if (configKey === descriptor.configKey) {
          const c = (step as unknown as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
          if (c && Array.isArray(c[fieldName])) {
            const childPreceding = new Set(preceding);
            (c[fieldName] as FlowStep[]).forEach((s, i) => {
              checkStep(s, `${pathPrefix}.${configKey}.${fieldName}[${i}]`, childPreceding);
              childPreceding.add(s.id);
            });
          }
        }
      }
    }
  }

  const preceding = new Set<string>();
  flow.steps.forEach((step, i) => {
    checkStep(step, `steps[${i}]`, preceding);
    preceding.add(step.id);
  });
  return errors;
}

// ── Output schema validation (cli#59) ──

const VALID_OUTPUT_SCHEMA_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'unknown']);

function isOutputSchemaObject(v: unknown): v is FlowOutputSchema {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Walk a declared outputSchema following a dot-path. Returns:
 *   - 'ok' if the path resolves to a declared field
 *   - 'unknown-field' if a segment is missing from the schema
 *   - 'opaque' if the path runs into a leaf type (e.g. `string`) but
 *     more segments remain — we can't validate further but it's not
 *     necessarily wrong
 */
function walkOutputSchema(schema: FlowOutputSchema, path: string[]): 'ok' | 'unknown-field' | 'opaque' {
  let current: FlowOutputSchema | string = schema;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (typeof current === 'string') {
      // Hit a leaf type with more path remaining; can't validate further.
      return current === 'unknown' || current === 'object' || current === 'array' ? 'opaque' : 'opaque';
    }
    if (!(seg in current)) return 'unknown-field';
    const next: FlowOutputSchema[string] = current[seg];
    if (typeof next === 'string') {
      if (!VALID_OUTPUT_SCHEMA_TYPES.has(next)) return 'unknown-field';
      current = next;
    } else if (isOutputSchemaObject(next)) {
      current = next;
    } else {
      return 'unknown-field';
    }
  }
  return 'ok';
}

/**
 * Collect every `outputSchema` declared anywhere in the flow's step tree,
 * keyed by step id.
 */
function collectOutputSchemas(flow: Flow): Map<string, FlowOutputSchema> {
  const out = new Map<string, FlowOutputSchema>();
  const nestedKeys = getNestedStepsKeys();
  function walk(steps: FlowStep[]): void {
    for (const step of steps) {
      if (step.outputSchema && isOutputSchemaObject(step.outputSchema)) {
        out.set(step.id, step.outputSchema);
      }
      for (const { configKey, fieldName } of nestedKeys) {
        const config = (step as unknown as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
        if (config && Array.isArray(config[fieldName])) {
          walk(config[fieldName] as FlowStep[]);
        }
      }
    }
  }
  walk(flow.steps);
  return out;
}

/**
 * For every step with a declared outputSchema, find downstream
 * `$.steps.<id>.output.<field>...` references and verify the field path
 * exists in the schema. Reports "unknown-field" mismatches as errors —
 * "opaque" walks (path runs past a primitive) are silently allowed.
 */
export function validateOutputSchemas(flow: Flow): ValidationError[] {
  const errors: ValidationError[] = [];
  const schemas = collectOutputSchemas(flow);
  if (schemas.size === 0) return errors;

  // Validate the schemas themselves
  for (const [stepId, schema] of schemas) {
    const schemaErrors = validateOutputSchemaShape(schema, `step "${stepId}".outputSchema`);
    errors.push(...schemaErrors);
  }

  const SELECTOR_RE = /\$\.steps\.([a-zA-Z_][\w-]*)\.output((?:\.[a-zA-Z_][\w-]*)+)/g;

  function checkText(text: unknown, location: string): void {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(SELECTOR_RE)) {
      const stepId = m[1];
      const tail = m[2].slice(1).split('.');
      const schema = schemas.get(stepId);
      if (!schema) continue; // step has no declared schema — nothing to check
      const result = walkOutputSchema(schema, tail);
      if (result === 'unknown-field') {
        errors.push({
          path: location,
          message: `Selector "${m[0]}" references field "${tail.join('.')}" which is not declared in step "${stepId}".outputSchema. Either fix the field name or update the outputSchema declaration.`,
        });
      }
    }
  }

  function walkValue(value: unknown, location: string): void {
    if (typeof value === 'string') {
      checkText(value, location);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walkValue(v, `${location}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        walkValue(v, `${location}.${k}`);
      }
    }
  }

  const nestedKeys = getNestedStepsKeys();
  // Build a set of "configKey.fieldName" combos that contain nested steps,
  // so walkValue can skip them and avoid double-reporting (each nested step
  // tree is visited explicitly by walkSteps further down).
  const nestedFieldSet = new Set(nestedKeys.map(k => `${k.configKey}.${k.fieldName}`));

  function walkConfig(config: unknown, configKey: string, pathPrefix: string): void {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      walkValue(config, pathPrefix);
      return;
    }
    for (const [k, v] of Object.entries(config)) {
      if (nestedFieldSet.has(`${configKey}.${k}`)) continue; // visited via walkSteps
      walkValue(v, `${pathPrefix}.${k}`);
    }
  }

  function walkSteps(steps: FlowStep[], pathPrefix: string): void {
    steps.forEach((step, i) => {
      const stepPath = `${pathPrefix}[${i}]`;
      // Check if/unless
      if (step.if) checkText(step.if, `${stepPath}.if`);
      if (step.unless) checkText(step.unless, `${stepPath}.unless`);
      if (Array.isArray(step.requires)) {
        step.requires.forEach((s, ri) => checkText(s, `${stepPath}.requires[${ri}]`));
      }
      // Check the type-specific config (skipping nested steps arrays — they
      // get walked explicitly below to avoid duplicate error reporting).
      const descriptor = getStepTypeDescriptor(step.type);
      if (descriptor) {
        const config = (step as unknown as Record<string, unknown>)[descriptor.configKey];
        if (config) walkConfig(config, descriptor.configKey, `${stepPath}.${descriptor.configKey}`);
        for (const { configKey, fieldName } of nestedKeys) {
          const c = (step as unknown as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
          if (c && Array.isArray(c[fieldName])) {
            walkSteps(c[fieldName] as FlowStep[], `${stepPath}.${configKey}.${fieldName}`);
          }
        }
      }
    });
  }
  walkSteps(flow.steps, 'steps');
  return errors;
}

function validateOutputSchemaShape(schema: unknown, location: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isOutputSchemaObject(schema)) {
    errors.push({ path: location, message: 'outputSchema must be an object' });
    return errors;
  }
  for (const [key, val] of Object.entries(schema)) {
    const where = `${location}.${key}`;
    if (typeof val === 'string') {
      if (!VALID_OUTPUT_SCHEMA_TYPES.has(val)) {
        errors.push({
          path: where,
          message: `outputSchema field "${key}" has unknown type "${val}". Allowed: ${[...VALID_OUTPUT_SCHEMA_TYPES].join(', ')}.`,
        });
      }
    } else if (isOutputSchemaObject(val)) {
      errors.push(...validateOutputSchemaShape(val, where));
    } else {
      errors.push({ path: where, message: `outputSchema field "${key}" must be a type string or a nested object` });
    }
  }
  return errors;
}

// ── Main entry point ──

export function validateFlow(flow: unknown, rootDir?: string): ValidationError[] {
  const schemaErrors = validateFlowSchema(flow);
  if (schemaErrors.length > 0) return schemaErrors;

  const f = flow as Flow;
  return [
    ...validateStepIds(f),
    ...validateSelectorReferences(f),
    ...validateOutputSchemas(f),
    ...(rootDir ? validateCodeModules(f, rootDir) : []),
  ];
}

// ── Code module syntax check ──

/**
 * Read every `code.module` file referenced by the flow and syntax-check its
 * contents. Catches brace/paren mismatches in `.mjs` modules at flow load
 * time instead of after upstream steps have already run.
 */
export function validateCodeModules(flow: Flow, rootDir: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const nestedKeys = getNestedStepsKeys();

  function walk(steps: FlowStep[], pathPrefix: string): void {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepPath = `${pathPrefix}[${i}]`;
      if (step.type === 'code' && step.code?.module) {
        const m = step.code.module;
        const abs = path.resolve(rootDir, m);
        if (!fs.existsSync(abs)) {
          errors.push({
            path: `${stepPath}.code.module`,
            message: `Code module "${m}" not found at ${abs}`,
          });
        } else {
          // Use `node --check` so import/export and other module-only syntax parses correctly.
          const res = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf-8' });
          if (res.status !== 0) {
            const msg = (res.stderr || '').split('\n').find(l => l.includes('SyntaxError') || l.includes('Error')) || res.stderr || 'Syntax check failed';
            errors.push({
              path: `${stepPath}.code.module`,
              message: `Syntax error in code module "${m}": ${msg.trim()}`,
            });
          }
        }
      }
      // Recurse into nested step arrays
      for (const { configKey, fieldName } of nestedKeys) {
        const config = (step as unknown as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
        if (config && Array.isArray(config[fieldName])) {
          walk(config[fieldName] as FlowStep[], `${stepPath}.${configKey}.${fieldName}`);
        }
      }
    }
  }

  walk(flow.steps, 'steps');
  return errors;
}
