/**
 * The workflow vocabulary: what a trigger, condition and action may be.
 *
 * One definition, served to the builder and enforced on save, so a stored graph
 * can never reference an action the executor does not implement. The filter DSL
 * learned this the hard way — a client-side copy of a vocabulary drifts into
 * offering things the server rejects.
 */

import { checkWebhookUrlShape } from './outbound-url';

export const TRIGGER_TYPES = [
  'CONVERSATION_CREATED',
  'KEYWORD_MATCHED',
  'TAG_ADDED',
  'TAG_REMOVED',
  'OUT_OF_HOURS',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const CONDITION_TYPES = [
  'WITHIN_BUSINESS_HOURS',
  'CONTACT_HAS_TAG',
  'CONTACT_LACKS_TAG',
  'CONVERSATION_TEAM_IS',
  'CONTACT_FIELD_EQUALS',
  'CONTACT_LIFECYCLE_IS',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const ACTION_TYPES = [
  'ASSIGN_TEAM',
  'ASSIGN_USER',
  'SEND_MESSAGE',
  'SEND_TEMPLATE',
  'ADD_TAG',
  'REMOVE_TAG',
  'UPDATE_CONTACT_FIELD',
  'HTTP_WEBHOOK',
  'WAIT_DELAY',
  'CLOSE_CONVERSATION',
  /**
   * The only action that contains other actions.
   *
   * Top-level `conditions` gate the whole run: fail one and nothing happens.
   * That cannot express "if a VIP, assign the senior team; otherwise tag it and
   * close" — the commonest shape an automation takes. `IF_ELSE` carries its own
   * conditions plus `then` and `else` branches, so a false test takes the second
   * path instead of ending the run.
   */
  'IF_ELSE',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type WorkflowCondition = { type: ConditionType; value?: string; field?: string };
export type WorkflowAction = {
  type: ActionType;
  /**
   * Present only on `IF_ELSE`. Typed here rather than left to `unknown` so the
   * executor and the validator agree on the shape of a branch.
   */
  conditions?: WorkflowCondition[];
  then?: WorkflowAction[];
  else?: WorkflowAction[];
  /** Free-form per action; validated by `validateWorkflowConfig`. */
  [key: string]: unknown;
};

/**
 * How deep branches may nest.
 *
 * Three is the same ceiling the contact filter DSL uses, for the same reason:
 * past it nobody can read the rule they wrote, and an unbounded structure is a
 * stack-overflow waiting for a hand-written payload.
 */
export const MAX_BRANCH_DEPTH = 3;

export type WorkflowConfig = {
  trigger?: { keyword?: string; tag?: string };
  conditions?: WorkflowCondition[];
  actions: WorkflowAction[];
};

/**
 * Hard ceiling on actions per workflow.
 *
 * Not arbitrary: every action is a database write or a network call inside one
 * queue job, and an unbounded list is how one tenant's workflow occupies the
 * worker indefinitely.
 */
/** Methods an HTTP Request node may use. No TRACE, no CONNECT. */
export const HTTP_METHODS = ['GET','POST','PUT','PATCH','DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const MAX_ACTIONS = 20;
export const MAX_CONDITIONS = 10;

/** Longest a WAIT_DELAY may pause. Beyond a week, a workflow is a scheduler. */
export const MAX_DELAY_MINUTES = 60 * 24 * 7;

export type ConfigValidation = { valid: boolean; errors: string[] };

function requireText(value: unknown, label: string, errors: string[], path: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${path}: ${label} is required`);
  }
}

/** Shared by the top-level gate and by every `IF_ELSE` branch. */
function validateConditions(raw: unknown, errors: string[], base: string): void {
  const conditions = raw || [];
  if (!Array.isArray(conditions)) {
    errors.push(`${base}: must be a list`);
    return;
  }
  if (conditions.length > MAX_CONDITIONS) {
    errors.push(`${base}: at most ${MAX_CONDITIONS} conditions`);
  }
  conditions.forEach((condition, index) => {
    const path = `${base}[${index}]`;
    if (!CONDITION_TYPES.includes(condition?.type)) {
      errors.push(`${path}: unsupported condition "${String(condition?.type)}"`);
      return;
    }
    if (condition.type !== 'WITHIN_BUSINESS_HOURS') {
      requireText(condition.value, 'a value', errors, path);
    }
    if (condition.type === 'CONTACT_FIELD_EQUALS') {
      requireText(condition.field, 'a field', errors, path);
    }
  });
}

/** Everything an action needs beyond its type. */
function validateAction(
  action: WorkflowAction,
  errors: string[],
  path: string,
  depth: number,
  budget: { spent: number },
): void {
  switch (action.type) {
    case 'ASSIGN_TEAM':
      requireText(action.teamId, 'a team', errors, path);
      break;
    case 'ASSIGN_USER':
      requireText(action.userId, 'a user', errors, path);
      break;
    case 'SEND_MESSAGE':
      requireText(action.body, 'message text', errors, path);
      break;
    case 'SEND_TEMPLATE':
      requireText(action.templateId, 'a template', errors, path);
      break;
    case 'ADD_TAG':
    case 'REMOVE_TAG':
      requireText(action.tag, 'a tag name', errors, path);
      break;
    case 'UPDATE_CONTACT_FIELD':
      requireText(action.field, 'a field', errors, path);
      break;

    case 'HTTP_WEBHOOK': {
      requireText(action.url, 'a URL', errors, path);
      if (typeof action.url === 'string' && action.url.trim()) {
        // Shape only — no DNS in a request handler. The resolved-address check
        // still runs at execution time and remains the authority.
        const problem = checkWebhookUrlShape(action.url);
        if (problem) errors.push(`${path}: ${problem}`);
      }
      if (action.method !== undefined && !HTTP_METHODS.includes(action.method as HttpMethod)) {
        errors.push(`${path}: unsupported method "${String(action.method)}"`);
      }
      if (action.auth !== undefined) {
        const auth = action.auth as Record<string, unknown> | null;
        if (auth) {
          const kind = String(auth.type || '');
          if (kind === 'bearer') {
            requireText(auth.token, 'a bearer token', errors, `${path}.auth`);
          } else if (kind === 'basic') {
            requireText(auth.username, 'a username', errors, `${path}.auth`);
            requireText(auth.password, 'a password', errors, `${path}.auth`);
          } else {
            errors.push(`${path}.auth: unsupported auth type "${kind}"`);
          }
        }
      }
      if (action.captureAs !== undefined) {
        // The captured name becomes a `{{variable}}` in later steps, so it has to
        // be a plain identifier — anything else would not be addressable.
        if (typeof action.captureAs !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(action.captureAs)) {
          errors.push(`${path}: captureAs must be a simple name (letters, digits, underscore)`);
        }
      }
      break;
    }

    case 'WAIT_DELAY': {
      if (depth > 0) {
        // A pause resumes the run from a top-level step index, which cannot
        // address a position inside a branch. Resuming would re-enter the
        // parent and skip the rest of that branch, so this is refused here
        // rather than half-supported at runtime.
        errors.push(`${path}: a delay cannot sit inside a branch`);
      }
      const minutes = Number(action.minutes);
      if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes <= 0) {
        errors.push(`${path}: delay must be a whole number of minutes`);
      } else if (minutes > MAX_DELAY_MINUTES) {
        errors.push(`${path}: delay cannot exceed ${MAX_DELAY_MINUTES} minutes`);
      }
      break;
    }

    case 'IF_ELSE': {
      validateConditions(action.conditions, errors, `${path}.conditions`);
      if (!Array.isArray(action.conditions) || action.conditions.length === 0) {
        errors.push(`${path}: a branch needs at least one condition`);
      }

      const hasThen = Array.isArray(action.then) && action.then.length > 0;
      const hasElse = Array.isArray(action.else) && action.else.length > 0;
      if (!hasThen && !hasElse) {
        // Both empty is a test whose outcome changes nothing — almost always a
        // half-finished branch rather than an intention.
        errors.push(`${path}: a branch needs actions on at least one side`);
      }
      if (action.then !== undefined) {
        validateActionList(action.then, errors, `${path}.then`, depth + 1, budget);
      }
      if (action.else !== undefined) {
        validateActionList(action.else, errors, `${path}.else`, depth + 1, budget);
      }
      break;
    }

    case 'CLOSE_CONVERSATION':
      // Nothing to configure: what the customer receives on close is the
      // CONVERSATION_CLOSED auto-reply the subscriber already edits in settings.
      break;

    default:
      break;
  }
}

/**
 * Validate a list of actions, descending into `IF_ELSE` branches.
 *
 * Depth and total count are bounded here rather than in the executor: a config
 * that cannot run should be refused at save, while someone is present to read
 * the error, not at 3am inside a queue job.
 */
function validateActionList(
  actions: unknown,
  errors: string[],
  base: string,
  depth: number,
  budget: { spent: number },
): void {
  if (!Array.isArray(actions)) {
    errors.push(`${base}: must be a list`);
    return;
  }
  if (depth > MAX_BRANCH_DEPTH) {
    errors.push(`${base}: branches may nest at most ${MAX_BRANCH_DEPTH} deep`);
    return;
  }

  actions.forEach((action, index) => {
    const path = `${base}[${index}]`;
    budget.spent += 1;
    if (!ACTION_TYPES.includes(action?.type)) {
      errors.push(`${path}: unsupported action "${String(action?.type)}"`);
      return;
    }
    validateAction(action, errors, path, depth, budget);
  });

  // A trailing wait does nothing but hold an execution row open. True of a
  // branch as much as of the top level.
  if (actions.length > 0 && actions[actions.length - 1]?.type === 'WAIT_DELAY') {
    errors.push(`${base}: cannot end with a delay`);
  }
}

/**
 * Validate a stored graph, collecting every problem rather than throwing on the
 * first — the builder shows these beside the step that caused them.
 */
export function validateWorkflowConfig(
  triggerType: unknown,
  raw: unknown,
): ConfigValidation {
  const errors: string[] = [];

  if (!TRIGGER_TYPES.includes(triggerType as TriggerType)) {
    errors.push(`trigger: unsupported trigger "${String(triggerType)}"`);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: [...errors, 'config: workflow configuration is not an object'] };
  }

  const config = raw as WorkflowConfig;

  // Triggers that carry their own operand are useless without it, and would
  // otherwise match every message or every tag.
  if (triggerType === 'KEYWORD_MATCHED') {
    requireText(config.trigger?.keyword, 'a keyword', errors, 'trigger');
  }
  if (triggerType === 'TAG_ADDED' || triggerType === 'TAG_REMOVED') {
    requireText(config.trigger?.tag, 'a tag name', errors, 'trigger');
  }

  validateConditions(config.conditions, errors, 'conditions');

  const actions = config.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    errors.push('actions: a workflow needs at least one action');
    return { valid: errors.length === 0, errors };
  }

  // Counted across branches rather than per list: twenty actions nested inside
  // three IF_ELSE branches would otherwise slip past a ceiling that exists to
  // bound how much work one queue job can do.
  const budget = { spent: 0 };
  validateActionList(actions, errors, 'actions', 0, budget);
  if (budget.spent > MAX_ACTIONS) {
    errors.push(`actions: at most ${MAX_ACTIONS} actions in total, including branches`);
  }

  return { valid: errors.length === 0, errors };
}

/** Vocabulary for the builder, so the UI never hardcodes its own copy. */
export function workflowVocabulary() {
  return {
    triggers: TRIGGER_TYPES,
    conditions: CONDITION_TYPES,
    actions: ACTION_TYPES,
    httpMethods: HTTP_METHODS,
    limits: {
      maxActions: MAX_ACTIONS,
      maxConditions: MAX_CONDITIONS,
      maxDelayMinutes: MAX_DELAY_MINUTES,
      maxBranchDepth: MAX_BRANCH_DEPTH,
    },
  };
}
