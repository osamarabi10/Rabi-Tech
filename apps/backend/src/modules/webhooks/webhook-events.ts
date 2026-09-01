/**
 * The events an outbound webhook can subscribe to.
 *
 * ## Eleven, matching the shape Respond.io publishes
 *
 * Copied in structure so an integrator moving between the two products does not
 * have to relearn the vocabulary, and adapted where our product differs — we
 * are a 1:1 WhatsApp platform, so there is no channel fan-out event and no
 * "comment" event, and we have a lifecycle stage they do not expose.
 *
 * ## Adding one is a contract change
 *
 * An event name that ships is a string somebody's receiver switches on. Renaming
 * it breaks them silently: their handler stops matching and the branch simply
 * never runs, with no error anywhere. Add new names; never repurpose an old one.
 */

export const WEBHOOK_EVENTS = [
  'contact.created',
  'contact.updated',
  'contact.tagged',
  'contact.lifecycle_updated',
  'contact.consent_updated',
  'conversation.opened',
  'conversation.assigned',
  'conversation.closed',
  'conversation.reopened',
  'message.received',
  'message.sent',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Grouped for the console's checkbox list, so a subscriber picks by subject
 * rather than reading eleven dotted strings.
 */
export const WEBHOOK_EVENT_GROUPS: { resource: string; events: WebhookEvent[] }[] = [
  {
    resource: 'contact',
    events: ['contact.created', 'contact.updated', 'contact.tagged', 'contact.lifecycle_updated', 'contact.consent_updated'],
  },
  {
    resource: 'conversation',
    events: ['conversation.opened', 'conversation.assigned', 'conversation.closed', 'conversation.reopened'],
  },
  {
    resource: 'message',
    events: ['message.received', 'message.sent'],
  },
];

/**
 * The envelope every delivery carries.
 *
 * `id` is per *delivery attempt* and `event.id` is per occurrence, which is what
 * makes a receiver able to deduplicate. A retry repeats `event.id` with a new
 * `id`; without that pair, a receiver cannot tell "we sent this twice" from "it
 * happened twice", and an order gets shipped again.
 */
export type WebhookEnvelope = {
  id: string;
  event: { id: string; type: WebhookEvent; occurredAt: string };
  workspace: { id: string };
  data: Record<string, unknown>;
};
