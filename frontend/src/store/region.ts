// Money and phone helpers (lib/format, lib/util) read the active workspace's currency and country. They are kept in step
// with the store here: a store change notifies this listener before React re-renders, so pages, toasts and exports all
// see the right currency the moment a workspace is opened or its settings are saved — nothing is set during rendering.
// A component that formats money without reading the workspace would not re-render on its own, so the router keys the
// open page by regionKey and remounts it when the currency or country changes.
import { syncRegion } from './regionSync';
import { useStore } from './store';

syncRegion(useStore.getState());
useStore.subscribe(syncRegion);
