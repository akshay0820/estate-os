// Money and phone helpers (lib/format, lib/util) read the active workspace's currency and country. They are kept in step
// with the store here: a store change notifies this listener before React re-renders, so pages, toasts and exports all
// see the right currency the moment a workspace is opened or its settings are saved — nothing is set during rendering.
import { setMoneyCurrency } from '@/lib/format';
import { setPhoneCountry } from '@/lib/util';
import { useStore } from './store';

type State = ReturnType<typeof useStore.getState>;

function sync(s: State) {
  const org = s.orgs.find((o) => o.id === s.session.orgId);
  setMoneyCurrency(org?.currency);
  setPhoneCountry(org?.country);
}

sync(useStore.getState());
useStore.subscribe(sync);
