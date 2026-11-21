// The one place a client deployment renames the product. Everything user-visible reads its name from here:
// the browser title (vite.config.ts injects it into index.html), the sidebar lockup, the assistant panel and the
// demo assistant's greeting.
//
// The Edge Functions keep a copy in supabase/functions/_shared/brand.ts (Deno code can't import from frontend/), and
// tests/brand.test.ts fails if the two drift — change both together. Colours are the --ember/--flame/--amber/--blaze
// tokens at the top of src/styles/tokens.css; the favicon is the data URI in index.html.
export const BRAND = {
  /** Product name in titles and copy. The sidebar wordmark splits it: last word becomes the small tag ("Estate" + "OS"). */
  productName: 'Estate OS',
  /** Maker line under the wordmark ("by …"). Empty string hides it. */
  company: 'BlazeReach',
  /** Name of the in-app chat assistant (Ctrl/⌘ J). */
  assistantName: 'Estate AI',
  /** Fallback agency name: what the voice agent says when a workspace has none, and form placeholders. */
  agencyName: 'Blaze Estate',
  /** First name the AI voice agent introduces itself with. */
  voiceAgentName: 'Avery',
} as const;

export type Brand = typeof BRAND;
