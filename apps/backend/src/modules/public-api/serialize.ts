import { displayE164 } from '../contacts/phone';

/**
 * What a contact looks like on the public API.
 *
 * ## An explicit field list, never the Prisma row
 *
 * Returning `contact` directly would publish every column this table ever
 * grows — internal flags, moderation state, whatever the next migration adds —
 * to third-party software, permanently and by accident. It also makes every
 * rename a breaking change for people we cannot contact. The cost of listing
 * fields by hand is one line per field; the cost of not doing it is a contract
 * nobody chose.
 *
 * Two columns are deliberately absent. `blockedById` names an internal user to
 * an outside caller who has no way to resolve it, and `consentSource` is an
 * audit field whose vocabulary is ours to change. `blocked` is exposed as a
 * boolean, because a caller about to send a message needs to know.
 *
 * ## Masking happens here
 *
 * One place, applied by the serializer rather than by each handler — a masking
 * rule that every endpoint must remember to apply is one the next endpoint
 * forgets. The token carries the flag; this function is the only thing that
 * reads it.
 */

const MASK = '••••••';

export type SerializableContact = {
  id: string;
  phone: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  language: string | null;
  countryCode: string | null;
  lifecycleStage: string | null;
  assigneeId: string | null;
  notes: string | null;
  isArchived: boolean;
  marketingConsent: string;
  blockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contactTags?: { tag: { id: string; name: string } | null }[];
  customFieldValues?: { value: string | null; fieldDefinition: { slug: string } | null }[];
  assignee?: { id: string; name: string } | null;
};

export function serializeContact(contact: SerializableContact, mask: boolean) {
  return {
    id: contact.id,
    // `+` form on the way out, digits in storage. The stored value is what the
    // gateway needs; the displayed one is what a human reads and what every
    // other API in this space returns.
    phone: mask ? MASK : displayE164(contact.phone),
    email: mask ? (contact.email ? MASK : null) : contact.email,
    // Named so a caller can tell "hidden from you" apart from "not set". Without
    // it a masked field is indistinguishable from an empty one, and an
    // integration writes over a value it was never allowed to see.
    masked: mask || undefined,
    name: contact.name,
    firstName: contact.firstName,
    lastName: contact.lastName,
    language: contact.language,
    countryCode: contact.countryCode,
    lifecycleStage: contact.lifecycleStage,
    assignee: contact.assignee ? { id: contact.assignee.id, name: contact.assignee.name } : null,
    notes: contact.notes,
    archived: contact.isArchived,
    blocked: !!contact.blockedAt,
    marketingConsent: contact.marketingConsent,
    tags: (contact.contactTags || []).map((row) => row.tag?.name).filter(Boolean),
    customFields: Object.fromEntries(
      (contact.customFieldValues || [])
        .filter((row) => row.fieldDefinition)
        .map((row) => [row.fieldDefinition!.slug, row.value]),
    ),
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

/** The include every contact response needs, so no handler forgets one. */
export const CONTACT_INCLUDE = {
  assignee: { select: { id: true, name: true } },
  contactTags: { include: { tag: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' as const } },
  customFieldValues: {
    include: { fieldDefinition: { select: { slug: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;
