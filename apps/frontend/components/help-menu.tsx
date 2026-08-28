'use client';

import Link from 'next/link';
import {
  BookOpen,
  Bug,
  CalendarDays,
  CircleDollarSign,
  Code2,
  ExternalLink,
  HelpCircle,
  Lightbulb,
  MessageCircleMore,
  PlaySquare,
  ScrollText,
  ServerCog,
  type LucideIcon,
} from 'lucide-react';
import { useT } from '@/lib/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type HelpItem = {
  label: string;
  description: string;
  icon: LucideIcon;
  href?: string;
  external?: boolean;
  unavailable?: boolean;
};

const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'owner@rabitech.co.il';
const mail = (subject: string) => `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}`;

const HELP_ITEMS: HelpItem[] = [
  { label: 'Help Center', description: 'Browse setup guides and common workspace workflows.', icon: BookOpen, href: '/onboarding#resources' },
  { label: 'Get Support', description: 'Contact the RabiTech support team by email.', icon: MessageCircleMore, href: mail('RabiTech support request') },
  { label: 'Report a Bug', description: 'Send the issue details and the page where it happened.', icon: Bug, href: mail('RabiTech bug report') },
  { label: 'Video Guides', description: 'Watch guided product walkthroughs.', icon: PlaySquare, href: process.env.NEXT_PUBLIC_VIDEO_GUIDES_URL, external: true, unavailable: !process.env.NEXT_PUBLIC_VIDEO_GUIDES_URL },
  { label: 'Book a Demo', description: 'Schedule a product walkthrough with the RabiTech team.', icon: CalendarDays, href: mail('Book a RabiTech demo') },
  { label: 'Developer Documentation', description: 'Read API and integration documentation.', icon: Code2, href: process.env.NEXT_PUBLIC_DEVELOPER_DOCS_URL, external: true, unavailable: !process.env.NEXT_PUBLIC_DEVELOPER_DOCS_URL },
  { label: 'Request a Feature', description: 'Share a product need with the roadmap team.', icon: Lightbulb, href: mail('RabiTech feature request') },
  { label: 'Refer & Earn', description: 'Invite another business through the referral program.', icon: CircleDollarSign, href: process.env.NEXT_PUBLIC_REFERRAL_URL, external: true, unavailable: !process.env.NEXT_PUBLIC_REFERRAL_URL },
  { label: 'Status Page', description: 'Check the live API and dependency health.', icon: ServerCog, href: process.env.NEXT_PUBLIC_STATUS_URL || '/api/health', external: true },
  { label: 'Privacy Policy', description: 'Review how account and contact data is handled.', icon: ScrollText, href: process.env.NEXT_PUBLIC_PRIVACY_URL, external: true, unavailable: !process.env.NEXT_PUBLIC_PRIVACY_URL },
];

function ItemBody({ item }: { item: HelpItem }) {
  const { t } = useT();
  const Icon = item.icon;
  return (
    <>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-xs font-semibold">
          {t(item.label)}
          {item.external && !item.unavailable && <ExternalLink className="size-3 text-muted-foreground" aria-hidden />}
        </span>
        <span className="mt-0.5 block whitespace-normal text-micro font-normal leading-4 text-muted-foreground">
          {t(item.unavailable ? 'Not available until its service is configured.' : item.description)}
        </span>
      </span>
    </>
  );
}

export function HelpMenu({ triggerClassName }: { triggerClassName?: string }) {
  const { t } = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={triggerClassName} aria-label={t('Help')}>
          <HelpCircle className="h-[18px] w-[18px]" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-[min(23rem,calc(100vw-1rem))] p-1.5">
        {HELP_ITEMS.map((item) => {
          if (item.unavailable || !item.href) {
            return (
              <DropdownMenuItem key={item.label} disabled className="items-start py-2 opacity-70">
                <ItemBody item={item} />
              </DropdownMenuItem>
            );
          }
          if (item.href.startsWith('/')) {
            return (
              <DropdownMenuItem key={item.label} asChild className="items-start py-2">
                <Link href={item.href}><ItemBody item={item} /></Link>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem key={item.label} asChild className="items-start py-2">
              <a href={item.href} target={item.external ? '_blank' : undefined} rel={item.external ? 'noreferrer' : undefined}>
                <ItemBody item={item} />
              </a>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
