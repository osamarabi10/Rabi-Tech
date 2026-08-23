import { redirect } from 'next/navigation';

/**
 * `/admin` is where people look for this.
 *
 * The console has always lived at `/platform`, and every link, bookmark and
 * audit-log entry in the product points there. Renaming it would break those to
 * satisfy a habit; leaving `/admin` returning a 404 leaves the habit unserved.
 *
 * A redirect costs one file and settles it. `/platform` remains the address.
 */
export default function AdminRedirect() {
  redirect('/platform');
}
