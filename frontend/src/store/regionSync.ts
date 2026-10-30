// The pure half of the region sync in ./region (kept apart from the store so it can be tested without a browser).
import { setMoneyCurrency } from '@/lib/format';
import { setPhoneCountry } from '@/lib/util';
import type { Organization } from './types';

export type RegionState = { orgs: Pick<Organization, 'id' | 'currency' | 'country'>[]; session: { orgId?: string | null } };

/** The active workspace's currency and country (undefined when no workspace is open). */
export function regionOf(s: RegionState) {
  const org = s.orgs.find((o) => o.id === s.session.orgId);
  return { currency: org?.currency, country: org?.country };
}

/** A string that changes whenever the active workspace's currency or country does. */
export const regionKey = (s: RegionState) => {
  const r = regionOf(s);
  return `${r.currency ?? ''}:${r.country ?? ''}`;
};

/** Points the money and phone helpers at the active workspace. */
export function syncRegion(s: RegionState) {
  const r = regionOf(s);
  setMoneyCurrency(r.currency);
  setPhoneCountry(r.country);
}
