import type { Flow, FlowStep, FlowStepType } from './flow-types.js';
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
        const config = (step as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
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
        const config = (step as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
        if (config && Array.isArray(config[fieldName])) {
          for (const id of getAllStepIds(config[fieldName] as FlowStep[])) ids.add(id);
        }
      }
    }
    return ids;
  }

  const allStepIds = getAllStepIds(flow.steps);

  function extractSelectors(value: unknown): string[] {
    const selectors: string[] = [];
    if (typeof value === 'string') {
      if (value.startsWith('$.')) {
        selectors.push(value);
      }
      const interpolated = value.matchAll(/\{\{(\$\.[^}]+)\}\}/g);
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

  function checkSelectors(selectors: string[], path: string): void {
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
        const stepId = parts[2];
        if (!allStepIds.has(stepId)) {
          errors.push({ path, message: `Selector "${selector}" references undefined step "${stepId}"` });
        }
      }
    }
  }

  function checkStep(step: FlowStep, pathPrefix: string): void {
    if (step.if) checkSelectors(extractSelectors(step.if), `${pathPrefix}.if`);
    if (step.unless) checkSelectors(extractSelectors(step.unless), `${pathPrefix}.unless`);

    // Check selectors in all config objects
    const descriptor = getStepTypeDescriptor(step.type);
    if (descriptor) {
      const config = (step as Record<string, unknown>)[descriptor.configKey];
      if (config && typeof config === 'object') {
        // Skip deep checking for expressions (transform, code) — they use $ directly
        if (step.type !== 'transform' && step.type !== 'code') {
          for (const [fieldName, fd] of Object.entries(descriptor.fields)) {
            if (fd.stepsArray) continue; // steps are checked recursively below
            const value = (config as Record<string, unknown>)[fieldName];
            if (value !== undefined) {
              checkSelectors(extractSelectors(value), `${pathPrefix}.${descriptor.configKey}.${fieldName}`);
            }
          }
        }
      }

      // Recurse into nested steps
      for (const { configKey, fieldName } of nestedKeys) {
        if (configKey === descriptor.configKey) {
          const c = (step as Record<string, unknown>)[configKey] as Record<string, unknown> | undefined;
          if (c && Array.isArray(c[fieldName])) {
            (c[fieldName] as FlowStep[]).forEach((s, i) =>
              checkStep(s, `${pathPrefix}.${configKey}.${fieldName}[${i}]`),
            );
          }
        }
      }
    }
  }

  flow.steps.forEach((step, i) => checkStep(step, `steps[${i}]`));
  return errors;
}

// ── Main entry point ──

export function validateFlow(flow: unknown): ValidationError[] {
  const schemaErrors = validateFlowSchema(flow);
  if (schemaErrors.length > 0) return schemaErrors;

  const f = flow as Flow;
  return [
    ...validateStepIds(f),
    ...validateSelectorReferences(f),
  ];
}
