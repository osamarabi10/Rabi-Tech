'use client';

import Link from 'next/link';
import {
  Building2,
  CalendarClock,
  ExternalLink,
  Layers3,
  MessageCircle,
  Radio,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { cn } from '@/lib/utils';

export type DrawerSubscriber = {
  id: string;
  name: string;
  slug?: string;
  status: string;
  tier?: string;
  emailVerifiedAt?: string | null;
  suspendAt?: string | null;
  suspendReason?: string | null;
  createdAt?: string;
  subscriptions?: Array<{
    planCode: string;
    status: string;
    trialEndsAt: string | null;
  }>;
  channels?: Array<{
    status: string;
    provisioningState: string;
    provisioningStep?: string | null;
    apiPort?: number | null;
    deploymentName?: string | null;
    failureReason?: string | null;
  }>;
  _count?: { users: number; whatsappSessions: number; workspaces?: number };
};

type SubscriberDrawerProps = {
  subscriber: DrawerSubscriber | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function dateLabel(value?: string | null) {
  if (!value) return 'Not set';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Not set' : parsed.toLocaleString('en-US');
}

export function SubscriberDrawer({ subscriber, open, onOpenChange }: SubscriberDrawerProps) {
  if (!subscriber) return null;

  const subscription = subscriber.subscriptions?.[0];
  const channel = subscriber.channels?.[0];
  const subscriberSearch = subscriber.slug || subscriber.name;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent closeLabel="Close subscriber details">
        <DrawerHeader className="bg-muted/30">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Building2 className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <DrawerTitle className="truncate text-base font-semibold">{subscriber.name}</DrawerTitle>
              <DrawerDescription className="mt-1 font-mono text-xs">
                {subscriber.slug || subscriber.id}
              </DrawerDescription>
            </div>
            <Badge
              variant="outline"
              className={cn(
                'shrink-0 uppercase',
                subscriber.status === 'ACTIVE'
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-destructive/30 bg-destructive/10 text-destructive',
              )}
            >
              {subscriber.status}
            </Badge>
          </div>
        </DrawerHeader>

        <DrawerBody className="p-0">
          <section aria-labelledby="drawer-service-heading" className="border-b border-border px-5 py-5">
            <h2 id="drawer-service-heading" className="text-xs font-semibold uppercase text-muted-foreground">
              Service state
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Plan</dt>
                <dd className="mt-1 font-semibold">{subscriber.tier || subscription?.planCode || 'No plan'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Billing</dt>
                <dd className="mt-1 font-semibold">{subscription?.status || 'No subscription'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Email</dt>
                <dd className="mt-1 font-semibold">{subscriber.emailVerifiedAt ? 'Verified' : 'Pending verification'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Trial ends</dt>
                <dd className="mt-1 text-xs font-medium">{dateLabel(subscription?.trialEndsAt)}</dd>
              </div>
            </dl>
            {subscriber.suspendReason ? (
              <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {subscriber.suspendReason}
              </p>
            ) : null}
          </section>

          <section aria-labelledby="drawer-gateway-heading" className="border-b border-border px-5 py-5">
            <div className="flex items-center justify-between gap-3">
              <h2 id="drawer-gateway-heading" className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                <Radio className="h-3.5 w-3.5" aria-hidden />
                WhatsApp channel
              </h2>
              <Badge variant={channel?.provisioningState === 'FAILED' ? 'destructive' : 'secondary'}>
                {channel?.provisioningState || 'NOT PROVISIONED'}
              </Badge>
            </div>
            {channel ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Runtime</dt>
                  <dd className="mt-1 truncate font-mono text-xs">{channel.deploymentName || 'Unmanaged'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">API port</dt>
                  <dd className="mt-1 font-mono text-xs">{channel.apiPort ? `:${channel.apiPort}` : 'Automatic'}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Latest state detail</dt>
                  <dd className={cn('mt-1 text-xs', channel.failureReason && 'font-medium text-destructive')}>
                    {channel.failureReason || channel.provisioningStep?.replaceAll('_', ' ') || 'No failure reported'}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">No WhatsApp channel is configured.</p>
            )}
          </section>

          <section aria-labelledby="drawer-resources-heading" className="px-5 py-5">
            <h2 id="drawer-resources-heading" className="text-xs font-semibold uppercase text-muted-foreground">
              Account footprint
            </h2>
            <div className="mt-3 grid grid-cols-3 divide-x divide-border overflow-hidden rounded-md border border-border bg-muted/20">
              <div className="px-2 py-3 text-center">
                <Users className="mx-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <p className="mt-1 font-mono text-lg font-semibold">{subscriber._count?.users ?? 0}</p>
                <p className="text-[10px] uppercase text-muted-foreground">Users</p>
              </div>
              <div className="px-2 py-3 text-center">
                <MessageCircle className="mx-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <p className="mt-1 font-mono text-lg font-semibold">{subscriber._count?.whatsappSessions ?? 0}</p>
                <p className="text-[10px] uppercase text-muted-foreground">Sessions</p>
              </div>
              <div className="px-2 py-3 text-center">
                <Layers3 className="mx-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <p className="mt-1 font-mono text-lg font-semibold">{subscriber._count?.workspaces ?? 0}</p>
                <p className="text-[10px] uppercase text-muted-foreground">Branches</p>
              </div>
            </div>
          </section>
        </DrawerBody>

        <DrawerFooter>
          <p className="me-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden />
            Read-only snapshot
          </p>
          <Button asChild size="sm">
            <Link href={`/platform/subscribers?search=${encodeURIComponent(subscriberSearch)}`}>
              Open subscriber record
              <ExternalLink className="ms-1.5 h-3.5 w-3.5" aria-hidden />
            </Link>
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
