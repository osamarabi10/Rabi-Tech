import { redirect } from 'next/navigation';
/** Folded into Settings tabs — Respond.io keeps admin config in one place. */
export default function Redirectusers() {
  redirect('/settings/general?tab=users');
}
