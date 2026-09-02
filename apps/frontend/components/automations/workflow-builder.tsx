'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  createWorkflow,
  fetchCrmTags,
  fetchCustomFieldDefinitions,
  fetchLifecycleStages,
  type LifecycleStage,
  fetchSystemUsers,
  fetchTemplates,
  fetchWorkflowSchema,
  updateWorkflow,
  type CrmTag,
  type CustomFieldDefinition,
  type SystemUser,
  type Template,
  type Workflow,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowSchema,
  fetchTeams,
  type Team,
} from '@/lib/data';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  ACTION_FIELDS, ANSWER_KIND_LABELS, actionLabel, conditionLabel, triggerLabel,
} from '@/lib/workflow-labels';

/**
 * Step builder: Trigger → Conditions → Actions.
 *
 * The vocabulary is fetched, never hardcoded — only the server can reject an
 * unknown step, so a client-side list drifts into offering actions that fail on
 * save. The labels are local (see lib/workflow-labels.ts); the *tokens* are not.
 *
 * Uses plain controlled state rather than a form library, matching every other
 * form in this codebase (the filter builder, the campaign composer, commercial
 * terms). One page using a different form idiom is a maintenance tax.
 */

type Draft = {
  name: string;
  description: string;
  triggerType: string;
  keyword: string;
  tag: string;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
};

const EMPTY: Draft = {
  name: '',
  description: '',
  triggerType: 'CONVERSATION_CREATED',
  keyword: '',
  tag: '',
  conditions: [],
  actions: [],
};

function draftFrom(workflow: Workflow | null): Draft {
  if (!workflow) return { ...EMPTY };
  return {
    name: workflow.name,
    description: workflow.description || '',
    triggerType: workflow.triggerType,
    keyword: String(workflow.configJson?.trigger?.keyword || ''),
    tag: String(workflow.configJson?.trigger?.tag || ''),
    conditions: workflow.configJson?.conditions || [],
    actions: workflow.configJson?.actions || [],
  };
}

export function WorkflowBuilder({
  open,
  workflow,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null = create. */
  workflow: Workflow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [schema, setSchema] = useState<WorkflowSchema | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Operands the builder offers instead of free text: picking a team from a
  // list beats typing an id that silently matches nothing.
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [tags, setTags] = useState<CrmTag[]>([]);
  const [fields, setFields] = useState<CustomFieldDefinition[]>([]);
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);

  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(workflow));
    setErrors([]);
    fetchWorkflowSchema().then(setSchema).catch(() => setSchema(null));
    fetchTeams().then(setTeams).catch(() => setTeams([]));
    fetchSystemUsers().then(setUsers).catch(() => setUsers([]));
    fetchCrmTags().then(setTags).catch(() => setTags([]));
    fetchCustomFieldDefinitions().then(setFields).catch(() => setFields([]));
    fetchLifecycleStages().then(setStages).catch(() => setStages([]));
    fetchTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [open, workflow]);

  const needsKeyword = draft.triggerType === 'KEYWORD_MATCHED';
  const needsTag = draft.triggerType === 'TAG_ADDED' || draft.triggerType === 'TAG_REMOVED';

  const config = useMemo(() => ({
    trigger: {
      ...(needsKeyword ? { keyword: draft.keyword.trim() } : {}),
      ...(needsTag ? { tag: draft.tag.trim() } : {}),
    },
    conditions: draft.conditions,
    actions: draft.actions,
  }), [draft, needsKeyword, needsTag]);

  const save = async () => {
    setSaving(true);
    setErrors([]);
    try {
      if (workflow) {
        await updateWorkflow(workflow.id, {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          triggerType: draft.triggerType,
          configJson: config,
        });
      } else {
        await createWorkflow({
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          triggerType: draft.triggerType,
          configJson: config,
        });
      }
      toast.success(t('تم حفظ الأتمتة'));
      onSaved();
      onClose();
    } catch (err) {
      const response = (err as { response?: { data?: { error?: string; details?: string[] } } })?.response?.data;
      // The server returns one message per broken step with its path. Showing
      // them all beats a single toast that names only the first problem.
      setErrors(response?.details || [response?.error || t('تعذّر حفظ الأتمتة')]);
    } finally {
      setSaving(false);
    }
  };

  const setAction = (index: number, next: WorkflowAction) =>
    setDraft((d) => ({ ...d, actions: d.actions.map((a, i) => (i === index ? next : a)) }));
  const setCondition = (index: number, next: WorkflowCondition) =>
    setDraft((d) => ({ ...d, conditions: d.conditions.map((c, i) => (i === index ? next : c)) }));

  const atActionLimit = Boolean(schema && draft.actions.length >= schema.limits.maxActions);
  const atConditionLimit = Boolean(schema && draft.conditions.length >= schema.limits.maxConditions);

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{workflow ? t('تعديل الأتمتة') : t('أتمتة جديدة')}</DialogTitle>
        </DialogHeader>

        {!schema ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('جاري التحميل...')}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">{t('الاسم')}</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder={t('مثال: طلبات الاسترجاع')}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('الوصف')}</Label>
                <Input
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                />
              </div>
            </div>

            {/* Step 1 — trigger */}
            <StepCard step={1} title={t('المُشغِّل')}>
              <select
                value={draft.triggerType}
                onChange={(e) => setDraft((d) => ({ ...d, triggerType: e.target.value }))}
                className="select-field w-full"
              >
                {schema.triggers.map((trigger) => (
                  <option key={trigger} value={trigger}>{t(triggerLabel(trigger))}</option>
                ))}
              </select>
              {needsKeyword && (
                <Input
                  className="mt-2"
                  value={draft.keyword}
                  onChange={(e) => setDraft((d) => ({ ...d, keyword: e.target.value }))}
                  placeholder={t('الكلمة المفتاحية')}
                />
              )}
              {needsTag && (
                <select
                  value={draft.tag}
                  onChange={(e) => setDraft((d) => ({ ...d, tag: e.target.value }))}
                  className="select-field mt-2 w-full"
                >
                  <option value="">{t('اختر الوسم')}</option>
                  {tags.map((tag) => <option key={tag.id} value={tag.name}>{tag.name}</option>)}
                </select>
              )}
            </StepCard>

            {/* Step 2 — conditions */}
            <StepCard
              step={2}
              title={t('الشروط')}
              hint={t('كل الشروط يجب أن تتحقق. بدون شروط تعمل الأتمتة دائمًا.')}
              onAdd={atConditionLimit ? undefined : () =>
                setDraft((d) => ({ ...d, conditions: [...d.conditions, { type: schema.conditions[0] }] }))}
            >
              {draft.conditions.length === 0 && (
                <p className="text-xs text-muted-foreground">{t('بدون شروط')}</p>
              )}
              {draft.conditions.map((condition, index) => (
                <div key={index} className="grid gap-2 md:grid-cols-[200px_1fr_40px]">
                  <select
                    value={condition.type}
                    onChange={(e) => setCondition(index, { type: e.target.value })}
                    className="select-field"
                  >
                    {schema.conditions.map((type) => (
                      <option key={type} value={type}>{t(conditionLabel(type))}</option>
                    ))}
                  </select>

                  {condition.type === 'WITHIN_BUSINESS_HOURS' ? (
                    <div />
                  ) : condition.type === 'CONVERSATION_TEAM_IS' ? (
                    <select
                      value={String(condition.value ?? '')}
                      onChange={(e) => setCondition(index, { ...condition, value: e.target.value })}
                      className="select-field"
                    >
                      <option value="">{t('اختر الفريق')}</option>
                      {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                    </select>
                  ) : condition.type === 'CONTACT_HAS_TAG' || condition.type === 'CONTACT_LACKS_TAG' ? (
                    <select
                      value={String(condition.value ?? '')}
                      onChange={(e) => setCondition(index, { ...condition, value: e.target.value })}
                      className="select-field"
                    >
                      <option value="">{t('اختر الوسم')}</option>
                      {tags.map((tag) => <option key={tag.id} value={tag.name}>{tag.name}</option>)}
                    </select>
                  ) : condition.type === 'CONTACT_FIELD_EQUALS' ? (
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={String(condition.field ?? '')}
                        onChange={(e) => setCondition(index, { ...condition, field: e.target.value })}
                        className="select-field"
                      >
                        <option value="">{t('الحقل')}</option>
                        {fields.map((f) => <option key={f.slug} value={f.slug}>{f.name}</option>)}
                      </select>
                      <Input
                        value={String(condition.value ?? '')}
                        onChange={(e) => setCondition(index, { ...condition, value: e.target.value })}
                        placeholder={t('القيمة')}
                      />
                    </div>
                  ) : (
                    <Input
                      value={String(condition.value ?? '')}
                      onChange={(e) => setCondition(index, { ...condition, value: e.target.value })}
                      placeholder={t('القيمة')}
                    />
                  )}

                  <Button
                    type="button" size="icon" variant="ghost"
                    onClick={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, i) => i !== index) }))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </StepCard>

            {/* Step 3 — actions */}
            <StepCard
              step={3}
              title={t('الإجراءات')}
              hint={t('تُنفَّذ بالترتيب. أي إجراء يفشل يوقف الأتمتة.')}
              onAdd={atActionLimit ? undefined : () =>
                setDraft((d) => ({ ...d, actions: [...d.actions, { type: schema.actions[0] }] }))}
            >
              {draft.actions.length === 0 && (
                <p className="text-xs text-warning">{t('أضف إجراءً واحدًا على الأقل')}</p>
              )}
              {draft.actions.map((action, index) => (
                <div key={index} className="grid gap-2 md:grid-cols-[200px_1fr_40px]">
                  <select
                    value={action.type}
                    onChange={(e) => setAction(index, { type: e.target.value })}
                    className="select-field"
                  >
                    {schema.actions.map((type) => (
                      <option key={type} value={type}>{t(actionLabel(type))}</option>
                    ))}
                  </select>

                  <ActionOperand
                    action={action}
                    onChange={(next) => setAction(index, next)}
                    teams={teams}
                    users={users}
                    tags={tags}
                    fields={fields}
                  stages={stages}
                    templates={templates}
                    conditionTypes={schema.conditions}
                    actionTypes={schema.actions}
                    maxDelayMinutes={schema.limits.maxDelayMinutes}
                    t={t}
                  />

                  <Button
                    type="button" size="icon" variant="ghost"
                    onClick={() => setDraft((d) => ({ ...d, actions: d.actions.filter((_, i) => i !== index) }))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </StepCard>

            {errors.length > 0 && (
              <ul className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-2">
                {errors.map((error, index) => (
                  <li key={index} className="text-caption text-destructive">{error}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('إلغاء')}</Button>
          <Button onClick={save} disabled={saving || !schema || !draft.name.trim()}>
            {saving && <Loader2 className="me-1 h-4 w-4 animate-spin" />}
            {t('حفظ')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepCard({
  step, title, hint, onAdd, children,
}: {
  step: number;
  title: string;
  hint?: string;
  onAdd?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-micro font-bold text-primary-foreground">
            {step}
          </span>
          <span className="text-xs font-semibold">{title}</span>
        </div>
        {onAdd && (
          <Button type="button" size="sm" variant="outline" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {hint && <p className="mb-2 text-caption text-muted-foreground">{hint}</p>}
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/** The second input an action needs, chosen from its declared operand kind. */
function ActionOperand({
  action, onChange, teams, users, tags, fields, stages, templates, conditionTypes, actionTypes, maxDelayMinutes, t,
}: {
  action: WorkflowAction;
  onChange: (next: WorkflowAction) => void;
  teams: Team[];
  users: SystemUser[];
  tags: CrmTag[];
  fields: CustomFieldDefinition[];
  stages: LifecycleStage[];
  templates: Template[];
  /** From the server schema, never a local copy — same rule as everywhere else. */
  conditionTypes: readonly string[];
  actionTypes: readonly string[];
  maxDelayMinutes: number;
  t: (key: string) => string;
}) {
  const kind = ACTION_FIELDS[action.type] || 'none';
  const select = 'select-field w-full';

  if (kind === 'branch') {
    return (
      <BranchEditor
        action={action}
        onChange={onChange}
        teams={teams}
        users={users}
        tags={tags}
        fields={fields}
        stages={stages}
        templates={templates}
        conditionTypes={conditionTypes}
        actionTypes={actionTypes}
        maxDelayMinutes={maxDelayMinutes}
        t={t}
      />
    );
  }

  if (kind === 'team') {
    return (
      <select className={select} value={String(action.teamId ?? '')} onChange={(e) => onChange({ ...action, teamId: e.target.value })}>
        <option value="">{t('اختر الفريق')}</option>
        {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
      </select>
    );
  }
  if (kind === 'user') {
    return (
      <select className={select} value={String(action.userId ?? '')} onChange={(e) => onChange({ ...action, userId: e.target.value })}>
        <option value="">{t('اختر الموظف')}</option>
        {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select>
    );
  }
  if (kind === 'template') {
    return (
      <select className={select} value={String(action.templateId ?? '')} onChange={(e) => onChange({ ...action, templateId: e.target.value })}>
        <option value="">{t('اختر القالب')}</option>
        {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.title}</option>)}
      </select>
    );
  }
  if (kind === 'tag') {
    return (
      <select className={select} value={String(action.tag ?? '')} onChange={(e) => onChange({ ...action, tag: e.target.value })}>
        <option value="">{t('اختر الوسم')}</option>
        {tags.map((tag) => <option key={tag.id} value={tag.name}>{tag.name}</option>)}
      </select>
    );
  }
  if (kind === 'customField') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <select className={select} value={String(action.field ?? '')} onChange={(e) => onChange({ ...action, field: e.target.value })}>
          <option value="">{t('الحقل')}</option>
          {fields.map((f) => <option key={f.slug} value={f.slug}>{f.name}</option>)}
        </select>
        <Input value={String(action.value ?? '')} onChange={(e) => onChange({ ...action, value: e.target.value })} placeholder={t('القيمة')} />
      </div>
    );
  }
  if (kind === 'lifecycleStage') {
    return (
      <select
        className={select}
        value={String(action.stageId ?? '')}
        onChange={(e) => onChange({ ...action, stageId: e.target.value })}
      >
        <option value="">{t('اختر المرحلة')}</option>
        {stages.map((stage) => (
          <option key={stage.id} value={stage.id}>{stage.name}</option>
        ))}
      </select>
    );
  }
  if (kind === 'question') {
    /*
      Ordered the way the author thinks about it: what the customer is asked,
      what counts as an answer, where it goes, then the two limits.

      The answer type sits beside the field on purpose. Picking "number" and
      storing into a text field is legal and usually a mistake, and the two
      being adjacent is the cheapest way to make that visible without the
      builder second-guessing the choice.
    */
    const answerKinds = ['text', 'email', 'phone', 'number'];
    return (
      <div className="space-y-1.5">
        <Input
          value={String(action.prompt ?? '')}
          onChange={(e) => onChange({ ...action, prompt: e.target.value })}
          placeholder={t('السؤال اللي بينبعت للعميل')}
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            className={select}
            value={String(action.expects ?? 'text')}
            onChange={(e) => onChange({ ...action, expects: e.target.value })}
          >
            {answerKinds.map((k) => (
              <option key={k} value={k}>{t(ANSWER_KIND_LABELS[k])}</option>
            ))}
          </select>
          <select
            className={select}
            value={String(action.field ?? '')}
            onChange={(e) => onChange({ ...action, field: e.target.value })}
          >
            <option value="">{t('يتخزن في حقل')}</option>
            {fields.map((f) => <option key={f.slug} value={f.slug}>{f.name}</option>)}
          </select>
        </div>
        {/*
          Only custom fields are offered, and that is the security boundary
          rather than a limitation of the picker: the server resolves this slug
          through CustomFieldDefinition, so a workflow can only ever write a
          field this organization defined. See D-31.
        */}
        {fields.length === 0 && (
          <p className="text-micro text-muted-foreground">
            {t('لازم تعرّف حقل مخصص أول، عشان تخزن فيه الجواب')}
          </p>
        )}
        <Input
          value={String(action.invalidPrompt ?? '')}
          onChange={(e) => onChange({ ...action, invalidPrompt: e.target.value })}
          placeholder={t('لو الجواب مش مفهوم، شو نرد؟ (اختياري)')}
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="flex items-center gap-1.5 text-micro text-muted-foreground">
            {t('ينتظر')}
            <Input
              type="number"
              min={5}
              max={10080}
              dir="ltr"
              className="numeric"
              value={String(action.timeoutMinutes ?? 1440)}
              onChange={(e) => onChange({ ...action, timeoutMinutes: Number(e.target.value) })}
            />
            {t('دقيقة')}
          </label>
          <label className="flex items-center gap-1.5 text-micro text-muted-foreground">
            {t('يعيد السؤال')}
            <Input
              type="number"
              min={1}
              max={3}
              dir="ltr"
              className="numeric"
              value={String(action.maxAttempts ?? 2)}
              onChange={(e) => onChange({ ...action, maxAttempts: Number(e.target.value) })}
            />
            {t('مرات')}
          </label>
        </div>
        <select
          className={select}
          value={String(action.onTimeout ?? 'STOP')}
          onChange={(e) => onChange({ ...action, onTimeout: e.target.value })}
        >
          <option value="STOP">{t('لو ما رد: توقف')}</option>
          <option value="CONTINUE">{t('لو ما رد: كمّل باقي الخطوات')}</option>
        </select>
      </div>
    );
  }
  if (kind === 'url') {
    const auth = (action.auth ?? null) as { type?: string; token?: string; username?: string; password?: string } | null;
    return (
      <div className="space-y-1.5">
        <div className="flex gap-1.5">
          <select
            className="select-field w-24 shrink-0"
            value={String(action.method ?? 'POST')}
            onChange={(e) => onChange({ ...action, method: e.target.value })}
            aria-label={t('الطريقة')}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
              <option key={method} value={method}>{method}</option>
            ))}
          </select>
          <Input
            value={String(action.url ?? '')}
            onChange={(e) => onChange({ ...action, url: e.target.value })}
            placeholder="https://example.com/hook"
            dir="ltr"
          />
        </div>

        <div className="flex gap-1.5">
          <select
            className="select-field w-28 shrink-0"
            value={auth?.type ?? ''}
            onChange={(e) => {
              const next = e.target.value;
              // Clearing auth removes the whole object rather than leaving an
              // empty one behind — the validator rejects an auth block with no
              // recognised type.
              if (!next) {
                const { auth: _dropped, ...rest } = action;
                onChange(rest as typeof action);
              } else {
                onChange({ ...action, auth: { type: next } });
              }
            }}
            aria-label={t('المصادقة')}
          >
            <option value="">{t('بدون مصادقة')}</option>
            <option value="bearer">Bearer</option>
            <option value="basic">Basic</option>
          </select>

          {auth?.type === 'bearer' && (
            <Input
              value={auth.token ?? ''}
              onChange={(e) => onChange({ ...action, auth: { ...auth, token: e.target.value } })}
              placeholder="token"
              dir="ltr"
              type="password"
            />
          )}
          {auth?.type === 'basic' && (
            <>
              <Input
                value={auth.username ?? ''}
                onChange={(e) => onChange({ ...action, auth: { ...auth, username: e.target.value } })}
                placeholder="username"
                dir="ltr"
              />
              <Input
                value={auth.password ?? ''}
                onChange={(e) => onChange({ ...action, auth: { ...auth, password: e.target.value } })}
                placeholder="password"
                dir="ltr"
                type="password"
              />
            </>
          )}
        </div>

        <Input
          value={String(action.captureAs ?? '')}
          onChange={(e) => onChange({ ...action, captureAs: e.target.value })}
          placeholder={t('احفظ الرد باسم (اختياري)')}
          dir="ltr"
        />
        <p className="text-micro text-muted-foreground">
          {t('استخدم {{الاسم.الحقل}} في الخطوات التالية')}
        </p>
        <p className="text-micro text-muted-foreground">{t('روابط https العامة فقط')}</p>
      </div>
    );
  }
  if (kind === 'minutes') {
    return (
      <Input
        type="number" min={1} max={maxDelayMinutes}
        value={String(action.minutes ?? '')}
        onChange={(e) => onChange({ ...action, minutes: Number(e.target.value) })}
        placeholder={t('دقائق')}
      />
    );
  }
  if (kind === 'text') {
    return (
      <Textarea
        rows={2}
        value={String(action.body ?? '')}
        onChange={(e) => onChange({ ...action, body: e.target.value })}
        placeholder={t('نص الرسالة — يدعم {{contactName}}')}
      />
    );
  }
  if (kind === 'comment') {
    return (
      <Textarea
        rows={2}
        value={String(action.body ?? '')}
        onChange={(e) => onChange({ ...action, body: e.target.value })}
        // Says what it is at the moment it is typed. An author who believes
        // this reaches the customer writes something different from one who
        // knows it does not.
        placeholder={t('ملاحظة داخلية — ما بتوصل العميل')}
      />
    );
  }
  return <div className={cn('self-center text-caption text-muted-foreground')}>{t('بدون إعدادات')}</div>;
}

/**
 * `IF_ELSE`: its own conditions, and the actions each side runs.
 *
 * One level deep. The executor and validator allow branches to nest three deep,
 * but a nested editor inside a dialog stops being readable at the second level —
 * so deeper graphs stay API-only until the canvas exists, rather than being
 * offered here in a form nobody can follow.
 *
 * `WAIT_DELAY` is filtered out of the inner picker because a pause cannot resume
 * into a branch; the server rejects it, and offering it would be an invitation
 * to an error message.
 */
function BranchEditor({
  action, onChange, teams, users, tags, fields, stages, templates, conditionTypes, actionTypes, maxDelayMinutes, t,
}: {
  action: WorkflowAction;
  onChange: (next: WorkflowAction) => void;
  teams: Team[];
  users: SystemUser[];
  tags: CrmTag[];
  fields: CustomFieldDefinition[];
  stages: LifecycleStage[];
  templates: Template[];
  conditionTypes: readonly string[];
  actionTypes: readonly string[];
  maxDelayMinutes: number;
  t: (key: string) => string;
}) {
  const conditions = (action.conditions as WorkflowCondition[] | undefined) ?? [];
  const branchActions = (side: 'then' | 'else') =>
    (action[side] as WorkflowAction[] | undefined) ?? [];

  // ASK_QUESTION joins WAIT_DELAY here for the same reason: resuming addresses a
  // top-level step index, which cannot name a position inside a branch. Offering
  // it would produce a graph the server refuses on save.
  const nestable = actionTypes.filter((type) => type !== 'WAIT_DELAY' && type !== 'IF_ELSE' && type !== 'ASK_QUESTION');

  const setSide = (side: 'then' | 'else', next: WorkflowAction[]) =>
    onChange({ ...action, [side]: next });

  const renderSide = (side: 'then' | 'else', title: string) => (
    <div className="rounded-md border border-border p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-caption font-semibold">{title}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          onClick={() => setSide(side, [...branchActions(side), { type: nestable[0] }])}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>

      {branchActions(side).length === 0 ? (
        <p className="text-micro text-muted-foreground">{t('لا شيء')}</p>
      ) : (
        <div className="space-y-1.5">
          {branchActions(side).map((inner, index) => (
            <div key={index} className="flex items-start gap-1.5">
              <select
                className="select-field-sm w-36 shrink-0"
                value={inner.type}
                onChange={(e) => {
                  const next = [...branchActions(side)];
                  next[index] = { type: e.target.value };
                  setSide(side, next);
                }}
              >
                {nestable.map((type) => (
                  <option key={type} value={type}>{t(actionLabel(type))}</option>
                ))}
              </select>

              <div className="min-w-0 flex-1">
                <ActionOperand
                  action={inner}
                  onChange={(nextAction) => {
                    const next = [...branchActions(side)];
                    next[index] = nextAction;
                    setSide(side, next);
                  }}
                  teams={teams}
                  users={users}
                  tags={tags}
                  fields={fields}
                  stages={stages}
                  templates={templates}
                  conditionTypes={conditionTypes}
                  actionTypes={actionTypes}
                  maxDelayMinutes={maxDelayMinutes}
                  t={t}
                />
              </div>

              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => setSide(side, branchActions(side).filter((_, i) => i !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="w-full space-y-2">
      <div className="rounded-md border border-border p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-caption font-semibold">{t('الشرط')}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1.5"
            onClick={() =>
              onChange({ ...action, conditions: [...conditions, { type: conditionTypes[0] } as WorkflowCondition] })
            }
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        {conditions.length === 0 ? (
          <p className="text-micro text-warning">{t('الفرع يحتاج شرطاً واحداً على الأقل')}</p>
        ) : (
          <div className="space-y-1.5">
            {conditions.map((condition, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <select
                  className="select-field-sm w-40 shrink-0"
                  value={condition.type}
                  onChange={(e) => {
                    const next = [...conditions];
                    next[index] = { ...next[index], type: e.target.value } as WorkflowCondition;
                    onChange({ ...action, conditions: next });
                  }}
                >
                  {conditionTypes.map((type) => (
                    <option key={type} value={type}>{t(conditionLabel(type))}</option>
                  ))}
                </select>

                {condition.type !== 'WITHIN_BUSINESS_HOURS' && (
                  <Input
                    className="h-8 text-caption"
                    value={String(condition.value ?? '')}
                    onChange={(e) => {
                      const next = [...conditions];
                      next[index] = { ...next[index], value: e.target.value };
                      onChange({ ...action, conditions: next });
                    }}
                    placeholder={t('القيمة')}
                  />
                )}

                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0"
                  onClick={() =>
                    onChange({ ...action, conditions: conditions.filter((_, i) => i !== index) })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {renderSide('then', t('عندها'))}
      {renderSide('else', t('وإلا'))}
    </div>
  );
}
