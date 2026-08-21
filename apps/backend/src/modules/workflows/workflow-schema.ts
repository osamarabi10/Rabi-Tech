/**
 * The workflow vocabulary: what a trigger, condition and action may be.
 *
 * One definition, served to the builder and enforced on save, so a stored graph
 * can never reference an action the executor does not implement. The filter DSL
 * learned this the hard way — a client-side copy of a vocabulary drifts into
 * offering things the server rejects.
 */

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
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type WorkflowCondition = { type: ConditionType; value?: string; field?: string };
export type WorkflowAction = {
  type: ActionType;
  /** Free-form per action; validated by `validateWorkflowConfig`. */
  [key: string]: unknown;
};

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

  const conditions = config.conditions || [];
  if (!Array.isArray(conditions)) {
    errors.push('conditions: must be a list');
  } else {
    if (conditions.length > MAX_CONDITIONS) {
      errors.push(`conditions: at most ${MAX_CONDITIONS} conditions`);
    }
    conditions.forEach((condition, index) => {
      const path = `conditions[${index}]`;
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

  const actions = config.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    errors.push('actions: a workflow needs at least one action');
    return { valid: errors.length === 0, errors };
  }
  if (actions.length > MAX_ACTIONS) {
    errors.push(`actions: at most ${MAX_ACTIONS} actions`);
  }

  actions.forEach((action, index) => {
    const path = `actions[${index}]`;
    if (!ACTION_TYPES.includes(action?.type)) {
      errors.push(`${path}: unsupported action "${String(action?.type)}"`);
      return;
    }
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
      case 'HTTP_WEBHOOK':
        requireText(action.url, 'a URL', errors, path);
        break;
      case 'WAIT_DELAY': {
        const minutes = Number(action.minutes);
        if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes <= 0) {
          errors.push(`${path}: delay must be a whole number of minutes`);
        } else if (minutes > MAX_DELAY_MINUTES) {
          errors.push(`${path}: delay cannot exceed ${MAX_DELAY_MINUTES} minutes`);
        }
        break;
      }
      default:
        break;
    }
  });

  // A trailing wait does nothing but hold an execution row open.
  if (actions[actions.length - 1]?.type === 'WAIT_DELAY') {
    errors.push('actions: a workflow cannot end with a delay');
  }

  return { valid: errors.length === 0, errors };
}

/** Vocabulary for the builder, so the UI never hardcodes its own copy. */
export function workflowVocabulary() {
  return {
    triggers: TRIGGER_TYPES,
    conditions: CONDITION_TYPES,
    actions: ACTION_TYPES,
    limits: { maxActions: MAX_ACTIONS, maxConditions: MAX_CONDITIONS, maxDelayMinutes: MAX_DELAY_MINUTES },
  };
}
