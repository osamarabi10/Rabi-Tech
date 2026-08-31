export type CampaignStatusFilter = 'ALL' | 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED';

export const CAMPAIGN_STATUS_FILTERS: Array<{ value: CampaignStatusFilter; label: string }> = [
  { value: 'ALL', label: 'كل الحالات' },
  { value: 'DRAFT', label: 'مسودة' },
  { value: 'SCHEDULED', label: 'مجدولة' },
  { value: 'SENDING', label: 'قيد الإرسال' },
  { value: 'SENT', label: 'مرسلة' },
  { value: 'FAILED', label: 'فاشلة' },
];

const STATUS_META: Record<Exclude<CampaignStatusFilter, 'ALL'>, { label: string; color: string }> = {
  DRAFT: { label: 'مسودة', color: 'hsl(var(--status-closed))' },
  SCHEDULED: { label: 'مجدولة', color: 'hsl(var(--status-pending))' },
  SENDING: { label: 'قيد الإرسال', color: 'hsl(var(--status-pending))' },
  SENT: { label: 'مرسلة', color: 'hsl(var(--status-open))' },
  FAILED: { label: 'فاشلة', color: 'hsl(var(--danger))' },
};

export function campaignStatusLabel(status: string, t: (key: string) => string): string {
  if (status in STATUS_META) return t(STATUS_META[status as Exclude<CampaignStatusFilter, 'ALL'>].label);
  return t('حالة غير معروفة');
}

export function campaignStatusColor(status: string): string {
  if (status in STATUS_META) return STATUS_META[status as Exclude<CampaignStatusFilter, 'ALL'>].color;
  return 'hsl(var(--muted-foreground))';
}
