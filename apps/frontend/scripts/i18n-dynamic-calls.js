/**
 * Dynamic `t()` call sites — the backlog, and the exemptions.
 *
 * `check:i18n` follows literal arguments. A call whose argument is not a literal
 * is a hole in coverage: the string it displays is checked nowhere, and its
 * translation can simply be missing without any gate noticing. That is how
 * thirty-seven strings shipped untranslated.
 *
 * Every such site must appear in exactly one of the two lists below, and the
 * distinction between them is the whole point.
 *
 * ## BACKLOG — seeded, not triaged
 *
 * These predate the ratchet. They are recorded so the number is **visible and
 * counted**, not because anyone has examined them or decided they are fine. A
 * backlog entry carries no justification on purpose: writing seventy-six
 * reasons in one sitting would produce seventy-six pieces of filler, and a list
 * of unconvincing reasons is worse than a counted backlog because it reads as a
 * decision that was never made.
 *
 * The healthy signal is this list shrinking.
 *
 * ## EXEMPT — examined, with a reason
 *
 * A site that has actually been looked at and genuinely cannot be a literal —
 * a server-supplied string, a value from a provider. Each carries a real reason
 * a reader can disagree with.
 *
 * The healthy signal is this list staying small.
 *
 * ## Done, for stage 2
 *
 * Every BACKLOG entry becomes either a resolution — the literal moves back
 * inside a `t()` call — or an EXEMPT entry with a reason, and BACKLOG reaches
 * zero.
 *
 * ## Keys
 *
 * `"<file> :: <argument text>": <count>`. Keyed by argument rather than by line
 * so ordinary edits above a call do not churn the list, and counted so a second
 * identical call in the same file is a new hole rather than a silent addition.
 */

/** Seeded 2026-09-03. No justification: these are not yet triaged. */
const BACKLOG = {
  "app/(dashboard)/automations/page.tsx :: runStatusLabel(stat.last.status)": 1,
  "app/(dashboard)/automations/page.tsx :: triggerLabel(workflow.triggerType)": 1,
  "app/(dashboard)/campaigns/page.tsx :: filter.label": 1,
  "app/(dashboard)/contacts/import/page.tsx :: PHONE_REASON_LABELS[result.reason]": 1,
  "app/(dashboard)/contacts/page.tsx :: column.label": 1,
  "app/(dashboard)/inbox/page.tsx :: m.failureReason": 1,
  "app/(dashboard)/inbox/page.tsx :: option.label": 2,
  "app/(dashboard)/inbox/page.tsx :: reason": 1,
  "app/(dashboard)/onboarding/page.tsx :: resource.description": 1,
  "app/(dashboard)/onboarding/page.tsx :: resource.title": 1,
  "app/(dashboard)/onboarding/page.tsx :: step.action": 1,
  "app/(dashboard)/onboarding/page.tsx :: step.description": 1,
  "app/(dashboard)/onboarding/page.tsx :: step.detail": 1,
  "app/(dashboard)/onboarding/page.tsx :: step.title": 1,
  "app/(dashboard)/reports/page.tsx :: BUCKET_LABEL[l] ?? l": 1,
  "app/(dashboard)/reports/page.tsx :: DIRECTION_LABEL[d.direction] ?? d.direction": 1,
  "app/(dashboard)/reports/page.tsx :: HEADLINE_LABEL[headline.key] ?? headline.key": 1,
  "app/(dashboard)/reports/page.tsx :: item.label": 1,
  "app/(dashboard)/reports/page.tsx :: sourceLabel[label] ?? label": 2,
  "app/(dashboard)/settings/general/page.tsx :: USAGE_LABELS[item.metric]": 1,
  "app/(dashboard)/settings/general/page.tsx :: d.label": 1,
  "app/(dashboard)/settings/general/page.tsx :: s.label": 1,
  "app/(dashboard)/settings/notifications/page.tsx :: field.description": 1,
  "app/(dashboard)/settings/notifications/page.tsx :: field.title": 3,
  "app/page.tsx :: section.label": 1,
  "components/app-sidebar.tsx :: item.label": 2,
  "components/app-sidebar.tsx :: option.label": 1,
  "components/automations/workflow-builder.tsx :: ANSWER_KIND_LABELS[k]": 1,
  "components/automations/workflow-builder.tsx :: actionLabel(type)": 2,
  "components/automations/workflow-builder.tsx :: conditionLabel(type)": 2,
  "components/automations/workflow-builder.tsx :: triggerLabel(trigger)": 1,
  "components/campaigns/campaign-composer.tsx :: s.label": 1,
  "components/contacts/contact-filter-builder.tsx :: categoryLabel(category)": 1,
  "components/contacts/contact-filter-builder.tsx :: enumValueLabel(option)": 1,
  "components/contacts/contact-filter-builder.tsx :: fieldLabel(field.field)": 1,
  "components/contacts/contact-filter-builder.tsx :: operatorLabel(operator)": 1,
  "components/help-menu.tsx :: item.label": 1,
  "components/inbox/consent-provenance.tsx :: SOURCE_LABEL[source] ?? source": 1,
  "components/inbox/contact-context-tabs.tsx :: ACTION_LABEL[event.action] ?? event.action": 1,
  "components/inbox/contact-conversations-tab.tsx :: STATUS_CONFIG[conversation.status]?.label ?? conversation.status": 1,
  "components/inbox/contact-tags-section.tsx :: `Tag source: ${tag.source}`": 1,
  "components/inbox/inbox-scope-menu.tsx :: copy.action.label": 1,
  "components/inbox/inbox-scope-menu.tsx :: copy.impact": 1,
  "components/inbox/inbox-scope-menu.tsx :: copy.label": 1,
  "components/inbox/inbox-selector.tsx :: gatewayText.action.label": 1,
  "components/inbox/inbox-selector.tsx :: gatewayText.impact": 1,
  "components/inbox/inbox-selector.tsx :: gatewayText.label": 1,
  "components/notification-bell.tsx :: item.label": 1,
  "components/permission-notice.tsx :: action": 1,
  "components/permission-notice.tsx :: who": 1,
  "components/reports/date-range-picker.tsx :: preset.label": 1,
  "components/reports/date-range-picker.tsx :: selected.label": 1,
  "components/reports/drilldown-panel.tsx :: METRIC_LABEL[metric]": 2,
  "components/reports/heatmap.tsx :: dayKey": 2,
  "components/settings/auto-replies-card.tsx :: info.label": 1,
  "components/settings/auto-replies-card.tsx :: info.when": 1,
  "components/settings/meta-channel-card.tsx :: PROBLEM_TEXT[code]": 1,
  "components/settings/meta-channel-card.tsx :: PROBLEM_TEXT[result.warning.code] || result.warning.message": 1,
  "components/settings/settings-rail.tsx :: item.label": 1,
  "components/settings/settings-sub-navigation.tsx :: section.label": 1,
  "components/settings/snippets-card.tsx :: CATEGORIES.find((c) => c.value === key)!.label": 1,
  "components/settings/snippets-card.tsx :: CATEGORIES.find((c) => c.value === tpl.category)?.label || tpl.category": 1,
  "components/settings/snippets-card.tsx :: activeCategory.hint": 1,
  "components/settings/snippets-card.tsx :: c.label": 1,
  "components/settings/team-members.tsx :: r.label": 1,
  "components/settings/team-routing.tsx :: active.hint": 1,
  "components/settings/team-routing.tsx :: s.label": 1,
  "components/settings/workspace-contact-fields.tsx :: `Field type: ${field.dataType}`": 1,
  "components/settings/workspace-contact-fields.tsx :: `Field type: ${type}`": 1,
  "components/settings/workspace-contact-fields.tsx :: field.visibility": 1,
  "components/settings/workspace-conversations.tsx :: label": 1,
  "components/status-badge.tsx :: label": 1,
  "components/upgrade-gate.tsx :: description": 1,
  "components/upgrade-gate.tsx :: title": 1,
  "lib/data.ts :: UNKNOWN_CONTACT": 1,
  "lib/inbox-view-capture.ts :: STATUS_LABELS[convFilter]": 1,};

/**
 * Examined, and genuinely not expressible as a literal. Each needs a reason
 * somebody can argue with.
 *
 * Empty at the ratchet's introduction, deliberately: nothing had been examined
 * yet, and seeding this list would have been claiming otherwise.
 */
const EXEMPT = {
  // '<file> :: <arg>': { count: 1, reason: 'why this cannot be a literal' },
};

module.exports = { BACKLOG, EXEMPT };
