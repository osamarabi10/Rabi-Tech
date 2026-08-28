"use client"

import { useId, type ReactNode } from "react"
import { AlertTriangle, ArrowUpCircle, Lock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export function UpgradeBadge({ label, className }: { label: string; className?: string }) {
  return <Badge variant="outline" className={cn("gap-1 border-primary/30 bg-primary/5 text-primary", className)}><Lock className="size-3" aria-hidden />{label}</Badge>
}

export function GateBanner({ title, description, action, className }: { title: string; description: string; action: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3 border border-primary/25 bg-primary/5 p-4 sm:flex-row sm:items-center", className)} aria-labelledby="gate-banner-title">
      <div className="flex min-w-0 flex-1 gap-3"><ArrowUpCircle className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden /><div><h2 id="gate-banner-title" className="text-small font-semibold">{title}</h2><p className="mt-1 text-caption text-muted-foreground">{description}</p></div></div>
      <div className="shrink-0">{action}</div>
    </section>
  )
}

export function DangerZone({ title, description, children, className }: { title: string; description: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("border border-warning/35 bg-warning/5 p-4", className)} aria-labelledby="danger-zone-title">
      <div className="flex gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden /><div className="min-w-0 flex-1"><h2 id="danger-zone-title" className="text-small font-semibold">{title}</h2><p className="mt-1 text-caption text-muted-foreground">{description}</p><div className="mt-4">{children}</div></div></div>
    </section>
  )
}

export function ToggleCard({ title, description, checked, onCheckedChange, disabled, disabledReason, className }: { title: string; description: string; checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; disabledReason?: string; className?: string }) {
  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`
  return (
    <div className={cn("flex gap-4 border-b border-border py-4 last:border-b-0", className)}>
      <div className="min-w-0 flex-1"><h3 id={titleId} className="text-small font-semibold">{title}</h3><p id={descriptionId} className="mt-1 text-caption text-muted-foreground">{description}</p>{disabled && disabledReason && <p className="mt-2 flex items-center gap-1 text-caption text-warning"><Lock className="size-3" aria-hidden />{disabledReason}</p>}</div>
      <label className="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center">
        <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} disabled={disabled} aria-labelledby={titleId} aria-describedby={descriptionId} className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
        <span className="pointer-events-none absolute inset-0 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-50" />
        <span className="pointer-events-none absolute start-0.5 size-5 rounded-full bg-card shadow-sm transition-transform peer-checked:translate-x-5 rtl:peer-checked:-translate-x-5" />
      </label>
    </div>
  )
}
