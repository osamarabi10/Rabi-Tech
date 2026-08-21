'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Shuffle } from 'lucide-react';
import { updateTeam, type Team, type AssignmentStrategy } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const STRATEGIES: Array<{ value: AssignmentStrategy; label: string; hint: string }> = [
  { value: 'NONE',        label: 'يدوي', hint: 'المحادثات تبقى بالطابور لحد ما يستلمها موظف' },
  { value: 'ROUND_ROBIN', label: 'بالتناوب', hint: 'توزيع بالتساوي على الموظفين المتاحين' },
  { value: 'LEAST_OPEN',  label: 'الأقل انشغالاً', hint: 'للموظف اللي عنده أقل محادثات مفتوحة' },
];

/**
 * Per-team automatic assignment. Sits inside the Teams card so an admin
 * configures routing where they manage the team, not on a separate screen.
 */
export function TeamRouting({ team, onSaved }: { team: Team; onSaved: () => void }) {
  const { t } = useT();
  const [strategy, setStrategy] = useState<AssignmentStrategy>(team.assignmentStrategy ?? 'NONE');
  const [cap, setCap] = useState<string>(
    team.maxConcurrentPerAgent != null ? String(team.maxConcurrentPerAgent) : '',
  );
  const [saving, setSaving] = useState(false);

  const dirty =
    strategy !== (team.assignmentStrategy ?? 'NONE') ||
    cap !== (team.maxConcurrentPerAgent != null ? String(team.maxConcurrentPerAgent) : '');

  const save = async () => {
    setSaving(true);
    try {
      await updateTeam(team.id, {
        assignmentStrategy: strategy,
        maxConcurrentPerAgent: cap.trim() === '' ? null : Number(cap),
      } as Partial<Team>);
      toast.success(t('تم حفظ إعدادات التوزيع'));
      onSaved();
    } catch {
      toast.error(t('فشل الحفظ'));
    } finally {
      setSaving(false);
    }
  };

  const active = STRATEGIES.find((s) => s.value === strategy);

  return (
    <div className="mt-3 rounded-lg border border-border bg-secondary/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Shuffle className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-semibold">{t('التوزيع التلقائي')}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-caption">{t('الطريقة')}</Label>
          <Select value={strategy} onValueChange={(v) => setStrategy(v as AssignmentStrategy)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STRATEGIES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {t(s.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-caption">{t('حد المحادثات لكل موظف')}</Label>
          <Input
            className="h-8 text-xs"
            type="number"
            min={1}
            placeholder={t('بدون حد')}
            value={cap}
            disabled={strategy === 'NONE'}
            onChange={(e) => setCap(e.target.value)}
          />
        </div>
      </div>

      {active && (
        <p className="mt-2 text-caption text-muted-foreground">{t(active.hint)}</p>
      )}
      {strategy !== 'NONE' && (
        <p className="mt-1 text-caption text-muted-foreground">
          {t('الموظفون في وضع الغياب أو اللي وصلوا للحد ما بيستلموا محادثات جديدة. إذا ما في حدا متاح، المحادثة بتضل بالطابور.')}
        </p>
      )}

      {dirty && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" disabled={saving} onClick={save}>
            {saving ? t('جارِ الحفظ...') : t('حفظ')}
          </Button>
        </div>
      )}
    </div>
  );
}
