import type { Flow, FlowStep, FlowStepType } from './flow-types.js';

export interface ValidationError {
  path: string;
  message: string;
}

const VALID_STEP_TYPES: FlowStepType[] = [
  'action', 'transform', 'code', 'condition', 'loop', 'parallel', 'file-read', 'file-write',
];

const VALID_INPUT_TYPES = ['string', 'number', 'boolean', 'object', 'array'];

const VALID_ERROR_STRATEGIES = ['fail', 'continue', 'retry', 'fallback'];

export function validateFlowSchema(flow: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!flow || typeof flow !== 'object') {
    errors.push({ path: '', message: 'Flow must be a JSON object' });
    return errors;
  }

  const f = flow as Record<string, unknown>;

  if (!f.key || typeof f.key !== 'string') {
    errors.push({ path: 'key', message: 'Flow must have a string "key"' });
  } else if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(f.key) && f.key.length > 1) {
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

  // Validate inputs
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
      if (!d.type || !VALID_INPUT_TYPES.includes(d.type as string)) {
        errors.push({ path: `${prefix}.type`, message: `Input type must be one of: ${VALID_INPUT_TYPES.join(', ')}` });
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

  // Validate steps
  if (!Array.isArray(f.steps)) {
    errors.push({ path: 'steps', message: 'Flow must have a "steps" array' });
  } else {
    validateStepsArray(f.steps as unknown[], 'steps', errors);
  }

  return errors;
}

function validateStepsArray(steps: unknown[], pathPrefix: string, errors: ValidationError[]): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const path = `${pathPrefix}[${i}]`;

    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push({ path, message: 'Step must be an object' });
      continue;
    }

    const s = step as Record<string, unknown>;

    if (!s.id || typeof s.id !== 'string') {
      errors.push({ path: `${path}.id`, message: 'Step must have a string "id"' });
    }
    if (!s.name || typeof s.name !== 'string') {
      errors.push({ path: `${path}.name`, message: 'Step must have a string "name"' });
    }
    if (!s.type || !VALID_STEP_TYPES.includes(s.type as FlowStepType)) {
      errors.push({ path: `${path}.type`, message: `Step type must be one of: ${VALID_STEP_TYPES.join(', ')}` });
    }

    if (s.onError && typeof s.onError === 'object') {
      const oe = s.onError as Record<string, unknown>;
      if (!VALID_ERROR_STRATEGIES.includes(oe.strategy as string)) {
        errors.push({ path: `${path}.onError.strategy`, message: `Error strategy must be one of: ${VALID_ERROR_STRATEGIES.join(', ')}` });
      }
    }

    // Type-specific validation
    const type = s.type as string;
    if (type === 'action') {
      if (!s.action || typeof s.action !== 'object') {
        errors.push({ path: `${path}.action`, message: 'Action step must have an "action" config object' });
      } else {
        const a = s.action as Record<string, unknown>;
        if (!a.platform) errors.push({ path: `${path}.action.platform`, message: 'Action must have "platform"' });
        if (!a.actionId) errors.push({ path: `${path}.action.actionId`, message: 'Action must have "actionId"' });
        if (!a.connectionKey) errors.push({ path: `${path}.action.connectionKey`, message: 'Action must have "connectionKey"' });
      }
    } else if (type === 'transform') {
      if (!s.transform || typeof s.transform !== 'object') {
        errors.push({ path: `${path}.transform`, message: 'Transform step must have a "transform" config object' });
      } else {
        const t = s.transform as Record<string, unknown>;
        if (!t.expression || typeof t.expression !== 'string') {
          errors.push({ path: `${path}.transform.expression`, message: 'Transform must have a string "expression"' });
        }
      }
    } else if (type === 'code') {
      if (!s.code || typeof s.code !== 'object') {
        errors.push({ path: `${path}.code`, message: 'Code step must have a "code" config object' });
      } else {
        const c = s.code as Record<string, unknown>;
        if (!c.source || typeof c.source !== 'string') {
          errors.push({ path: `${path}.code.source`, message: 'Code must have a string "source"' });
        }
      }
    } else if (type === 'condition') {
      if (!s.condition || typeof s.condition !== 'object') {
        errors.push({ path: `${path}.condition`, message: 'Condition step must have a "condition" config object' });
      } else {
        const c = s.condition as Record<string, unknown>;
        if (!c.expression || typeof c.expression !== 'string') {
          errors.push({ path: `${path}.condition.expression`, message: 'Condition must have a string "expression"' });
        }
        if (!Array.isArray(c.then)) {
          errors.push({ path: `${path}.condition.then`, message: 'Condition must have a "then" steps array' });
        } else {
          validateStepsArray(c.then, `${path}.condition.then`, errors);
        }
        if (c.else !== undefined) {
          if (!Array.isArray(c.else)) {
            errors.push({ path: `${path}.condition.else`, message: 'Condition "else" must be a steps array' });
          } else {
            validateStepsArray(c.else, `${path}.condition.else`, errors);
          }
        }
      }
    } else if (type === 'loop') {
      if (!s.loop || typeof s.loop !== 'object') {
        errors.push({ path: `${path}.loop`, message: 'Loop step must have a "loop" config object' });
      } else {
        const l = s.loop as Record<string, unknown>;
        if (!l.over || typeof l.over !== 'string') {
          errors.push({ path: `${path}.loop.over`, message: 'Loop must have a string "over" selector' });
        }
        if (!l.as || typeof l.as !== 'string') {
          errors.push({ path: `${path}.loop.as`, message: 'Loop must have a string "as" variable name' });
        }
        if (!Array.isArray(l.steps)) {
          errors.push({ path: `${path}.loop.steps`, message: 'Loop must have a "steps" array' });
        } else {
          validateStepsArray(l.steps, `${path}.loop.steps`, errors);
        }
      }
    } else if (type === 'parallel') {
      if (!s.parallel || typeof s.parallel !== 'object') {
        errors.push({ path: `${path}.parallel`, message: 'Parallel step must have a "parallel" config object' });
      } else {
        const par = s.parallel as Record<string, unknown>;
        if (!Array.isArray(par.steps)) {
          errors.push({ path: `${path}.parallel.steps`, message: 'Parallel must have a "steps" array' });
        } else {
          validateStepsArray(par.steps, `${path}.parallel.steps`, errors);
        }
      }
    } else if (type === 'file-read') {
      if (!s.fileRead || typeof s.fileRead !== 'object') {
        errors.push({ path: `${path}.fileRead`, message: 'File-read step must have a "fileRead" config object' });
      } else {
        const fr = s.fileRead as Record<string, unknown>;
        if (!fr.path || typeof fr.path !== 'string') {
          errors.push({ path: `${path}.fileRead.path`, message: 'File-read must have a string "path"' });
        }
      }
    } else if (type === 'file-write') {
      if (!s.fileWrite || typeof s.fileWrite !== 'object') {
        errors.push({ path: `${path}.fileWrite`, message: 'File-write step must have a "fileWrite" config object' });
      } else {
        const fw = s.fileWrite as Record<string, unknown>;
        if (!fw.path || typeof fw.path !== 'string') {
          errors.push({ path: `${path}.fileWrite.path`, message: 'File-write must have a string "path"' });
        }
        if (fw.content === undefined) {
          errors.push({ path: `${path}.fileWrite.content`, message: 'File-write must have "content"' });
        }
      }
    }
  }
}

export function validateStepIds(flow: Flow): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();

  function collectIds(steps: FlowStep[], pathPrefix: string): void {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const path = `${pathPrefix}[${i}]`;

      if (seen.has(step.id)) {
        errors.push({ path: `${path}.id`, message: `Duplicate step ID: "${step.id}"` });
      } else {
        seen.add(step.id);
      }

      if (step.condition) {
        if (step.condition.then) collectIds(step.condition.then, `${path}.condition.then`);
        if (step.condition.else) collectIds(step.condition.else, `${path}.condition.else`);
      }
      if (step.loop?.steps) collectIds(step.loop.steps, `${path}.loop.steps`);
      if (step.parallel?.steps) collectIds(step.parallel.steps, `${path}.parallel.steps`);
    }
  }

  collectIds(flow.steps, 'steps');
  return errors;
}

export function validateSelectorReferences(flow: Flow): ValidationError[] {
  const errors: ValidationError[] = [];
  const inputNames = new Set(Object.keys(flow.inputs));

  function getAllStepIds(steps: FlowStep[]): Set<string> {
    const ids = new Set<string>();
    for (const step of steps) {
      ids.add(step.id);
      if (step.condition) {
        for (const id of getAllStepIds(step.condition.then)) ids.add(id);
        if (step.condition.else) {
          for (const id of getAllStepIds(step.condition.else)) ids.add(id);
        }
      }
      if (step.loop?.steps) {
        for (const id of getAllStepIds(step.loop.steps)) ids.add(id);
      }
      if (step.parallel?.steps) {
        for (const id of getAllStepIds(step.parallel.steps)) ids.add(id);
      }
    }
    return ids;
  }

  const allStepIds = getAllStepIds(flow.steps);

  function extractSelectors(value: unknown): string[] {
    const selectors: string[] = [];
    if (typeof value === 'string') {
      // Match standalone selectors
      if (value.startsWith('$.')) {
        selectors.push(value);
      }
      // Match interpolated selectors
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

      const root = parts[1]; // input, steps, env, loop
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
      // env and loop are runtime — skip
    }
  }

  function checkStep(step: FlowStep, pathPrefix: string): void {
    if (step.if) checkSelectors(extractSelectors(step.if), `${pathPrefix}.if`);
    if (step.unless) checkSelectors(extractSelectors(step.unless), `${pathPrefix}.unless`);

    if (step.action) {
      checkSelectors(extractSelectors(step.action), `${pathPrefix}.action`);
    }
    if (step.transform) {
      // Expressions use $ directly, not $.xxx selectors — skip deep checking
    }
    if (step.condition) {
      checkStep({ id: '__cond_expr', name: '', type: 'transform', transform: { expression: '' } }, pathPrefix);
      step.condition.then.forEach((s, i) => checkStep(s, `${pathPrefix}.condition.then[${i}]`));
      step.condition.else?.forEach((s, i) => checkStep(s, `${pathPrefix}.condition.else[${i}]`));
    }
    if (step.loop) {
      checkSelectors(extractSelectors(step.loop.over), `${pathPrefix}.loop.over`);
      step.loop.steps.forEach((s, i) => checkStep(s, `${pathPrefix}.loop.steps[${i}]`));
    }
    if (step.parallel) {
      step.parallel.steps.forEach((s, i) => checkStep(s, `${pathPrefix}.parallel.steps[${i}]`));
    }
    if (step.fileRead) {
      checkSelectors(extractSelectors(step.fileRead.path), `${pathPrefix}.fileRead.path`);
    }
    if (step.fileWrite) {
      checkSelectors(extractSelectors(step.fileWrite.path), `${pathPrefix}.fileWrite.path`);
      checkSelectors(extractSelectors(step.fileWrite.content), `${pathPrefix}.fileWrite.content`);
    }
  }

  flow.steps.forEach((step, i) => checkStep(step, `steps[${i}]`));
  return errors;
}

export function validateFlow(flow: unknown): ValidationError[] {
  const schemaErrors = validateFlowSchema(flow);
  if (schemaErrors.length > 0) return schemaErrors;

  const f = flow as Flow;
  return [
    ...validateStepIds(f),
    ...validateSelectorReferences(f),
  ];
}
