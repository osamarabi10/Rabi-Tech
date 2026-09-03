import { redirect } from 'next/navigation';
/** Snippets are organization settings, separate from provider message templates. */
export default function Redirecttemplates() {
  redirect('/settings/snippets');
}
