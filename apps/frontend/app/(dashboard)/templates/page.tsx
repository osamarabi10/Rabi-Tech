import { redirect } from 'next/navigation';
/** Folded into Settings tabs — Respond.io keeps admin config in one place. */
export default function Redirecttemplates() {
  redirect('/settings?tab=templates');
}
