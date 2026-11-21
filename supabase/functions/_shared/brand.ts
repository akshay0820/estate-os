// Server copy of frontend/src/brand.ts (Deno code can't import from frontend/). frontend/tests/brand.test.ts fails if
// the two drift — change both together. Used by the assistant's system prompt and the voice agent persona.
export const BRAND = {
  productName: 'Estate OS',
  company: 'BlazeReach',
  assistantName: 'Estate AI',
  agencyName: 'Blaze Estate',
  voiceAgentName: 'Avery',
} as const;
