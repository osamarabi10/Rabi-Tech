"use client"

import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function ConfirmDialog({ open, onOpenChange, title, description, cancelLabel, confirmLabel, onConfirm, busy, destructive = true, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; cancelLabel: string; confirmLabel: string; onConfirm: () => void | Promise<void>; busy?: boolean; destructive?: boolean; children?: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        {children}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{cancelLabel}</Button>
          <Button type="button" variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
