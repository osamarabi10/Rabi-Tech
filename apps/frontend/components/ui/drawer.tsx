"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog"

const Drawer = Dialog
const DrawerTrigger = DialogPrimitive.Trigger
const DrawerClose = DialogPrimitive.Close

const DrawerContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { closeLabel: string }
>(({ className, children, closeLabel, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} className={cn("fixed inset-y-0 end-0 z-50 flex h-full w-full max-w-md flex-col border-s border-border bg-background shadow-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right rtl:data-[state=closed]:slide-out-to-left rtl:data-[state=open]:slide-in-from-left", className)} {...props}>
      {children}
      <DialogPrimitive.Close className="absolute end-3 top-3 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" /><span className="sr-only">{closeLabel}</span></DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DrawerContent.displayName = "DrawerContent"

const DrawerHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("border-b border-border px-5 py-4 pe-12", className)} {...props} />
const DrawerBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("min-h-0 flex-1 overflow-y-auto p-5", className)} {...props} />
const DrawerFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4", className)} {...props} />
const DrawerTitle = DialogPrimitive.Title
const DrawerDescription = DialogPrimitive.Description

export { Drawer, DrawerTrigger, DrawerClose, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter, DrawerTitle, DrawerDescription }
