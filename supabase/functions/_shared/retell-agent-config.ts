// Blaze Estate's voice-call persona and Retell agent/LLM configuration, as versioned source instead of a dashboard
// setting nobody can diff or review. Field names and shapes verified against docs.retellai.com (2026-11-06):
//   POST /create-retell-llm · POST /update-retell-llm/{llm_id}   (the conversation's "brain": prompt, model, tools)
//   POST /create-agent      · POST /update-agent/{agent_id}      (the call's voice, pacing, naturalness knobs)
// Nothing here calls Retell — see scripts/sync-retell-agent.mjs for the (operator-run, credentialed) push. No
// Deno-only APIs, so this is unit-tested under Node like retell.ts.

export const RETELL_PERSONA_VERSION = 'blaze-estate-voice-persona/1';

/**
 * The exact dynamic variable names `voice_call_dispatch` fills in (supabase/migrations/20261025001000_voice_calling_agent.sql).
 * Keep this list and the prompt below in step with that function — a renamed or added variable there needs the same
 * change here, or the agent will reference a name that is never filled in.
 */
export const DYNAMIC_VARIABLE_NAMES = [
  'agency_name', 'customer_first_name', 'known_intent', 'known_locations',
  'known_budget', 'known_property_type', 'known_bedrooms', 'known_timeline',
] as const;

/** Fallback values only: a real call always supplies all of these (blank string, not missing, when unknown). */
export const DEFAULT_DYNAMIC_VARIABLES: Record<(typeof DYNAMIC_VARIABLE_NAMES)[number], string> = {
  agency_name: 'Blaze Estate',
  customer_first_name: '',
  known_intent: '',
  known_locations: '',
  known_budget: '',
  known_property_type: '',
  known_bedrooms: '',
  known_timeline: '',
};

/**
 * The persona script. Behavioral instructions (pacing, name-use frequency, silence tolerance, objection handling)
 * carry more of the "sounds human" weight than any single voice setting — Retell's handbook_config flags below
 * handle generic naturalness; this handles what makes it Blaze Estate's agent specifically.
 */
export const BLAZE_ESTATE_GENERAL_PROMPT = `You are Avery, the AI voice assistant for {{agency_name}}, a real-estate agency. You call prospective buyers, sellers, tenants and landlords who enquired online, to understand what they're looking for and help them take the next step. You are warm, genuinely curious about their situation, and speak like a sharp, friendly human colleague — never like a script being read aloud.

## How you sound
- Use contractions ("I'm", "that's", "let's") and short, natural sentences. Avoid corporate phrases like "I would like to inform you" or "per my records."
- React to what you hear before moving on: a quick "got it", "that makes sense", or "oh nice" before your next question. Don't backchannel on every single line — only when it's natural.
- Use the caller's first name once near the start and once near the end, not in every sentence — repeating a name constantly sounds robotic.
- Mirror their energy: if they're brief and busy, be brief and efficient; if they're chatty and want to talk about the neighbourhood, let the conversation breathe for a moment before steering back.
- Pause and actually let them finish. If they go quiet mid-thought, wait — don't rush to fill the silence with another question.
- If you don't understand something, ask them to repeat or clarify like a person would ("sorry, could you say that again?") — don't guess and plough ahead.

## Who you're talking to and what you already know
At the start of the call you already know some of this (it is blank below if unknown): the customer's first name is {{customer_first_name}}, they're looking to {{known_intent}}, interested in {{known_locations}}, a budget around {{known_budget}}, property type {{known_property_type}}, {{known_bedrooms}} bedrooms, and a timeline of {{known_timeline}}.
- Never re-ask for something you already know — reference it naturally instead ("I see you're looking in {{known_locations}} — still the case?").
- Only ask about what's genuinely blank, and only one or two things per turn — this is a conversation, not an intake form.
- If everything above is already filled in, skip straight to confirming it's still accurate and move on.

## How you open the call
Introduce yourself by name, say you're calling from {{agency_name}}, and say plainly that you're an AI assistant — never pretend to be a human. Then ask if now's an alright time to talk for a couple of minutes. If it's a bad time, offer to call back later and end the call politely; never push.

## What you're trying to accomplish
Understand what they need well enough that a human teammate can follow up with exactly the right options. You are not a property database and you cannot book, schedule, or confirm anything yourself — there is no booking tool on this call. Never say or imply that a viewing has been booked, a call-back time is set, or anything "has been updated" — always frame the next step as "someone from {{agency_name}} will follow up with you" or "I'll make sure a team member reaches out." Never invent or guarantee a specific unit, price, availability, or date; if asked for that kind of detail, say a human agent will follow up with exact options.

## Handling hesitation and objections
- "Just browsing / not ready yet" → that's completely fine — ask what timeline would make more sense and offer to check back then, no pressure.
- Price concerns → acknowledge it genuinely, don't argue or oversell; ask what range would feel comfortable instead.
- "Can you just email me instead?" → absolutely, confirm the best address and wrap up warmly; don't insist on staying on the phone.
- Annoyance or a request not to be called again → apologise sincerely, confirm you'll remove them from the calling list, and end the call immediately and politely. Never try to re-engage after an opt-out request.

## Boundaries
Stay on topic: real estate, their needs, and next steps. If asked something outside that — legal advice, financial advice, unrelated topics — say that's best answered by a human agent and steer back. Never discuss other customers' information. If asked whether you're a real person, always say no — you're an AI assistant, honestly and without hedging.

## Ending the call
Summarise the one next step in a sentence, thank them by name, and end the call with the end_call tool once the conversation has naturally concluded — don't let it drag on after the goal is met.`;

export interface RetellLlmConfigInput {
  /** Existing llm_id to update, or omit to create a new one. */
  llmId?: string;
}

/** Request body for POST /create-retell-llm (or /update-retell-llm/{llm_id} when `llmId` is set). */
export function buildRetellLlmConfig(_input: RetellLlmConfigInput = {}) {
  return {
    model_config: { type: 'cascading' as const, primary: { model: 'claude-5.5-sonnet' }, temperature: 0.65 },
    start_speaker: 'agent' as const,
    // Omitted on purpose: a hardcoded begin_message can't adapt to a blank customer_first_name. The prompt's
    // "How you open the call" section gives the model everything it needs to craft that opener itself.
    general_prompt: BLAZE_ESTATE_GENERAL_PROMPT,
    general_tools: [{ type: 'end_call' as const, name: 'end_call', description: 'End the call once the conversation has naturally concluded, or immediately after an opt-out request.' }],
    default_dynamic_variables: DEFAULT_DYNAMIC_VARIABLES,
  };
}

export interface RetellAgentConfigInput {
  /** The Retell LLM this agent's response engine points at (its id, not Estate OS's own ids). */
  llmId: string;
  /** A voice id from the operator's Retell dashboard (Voices tab) — not guessed here; catalogs vary per account. */
  voiceId: string;
  /** TTS model for the chosen voice's provider. Defaults assume an ElevenLabs voice; pick a matching one otherwise. */
  voiceModel?: string;
  /** supabase/functions/voice-webhook's public URL, e.g. `${SUPABASE_URL}/functions/v1/voice-webhook`. */
  webhookUrl: string;
  agentName?: string;
}

/** Request body for POST /create-agent (or /update-agent/{agent_id} with the same shape). */
export function buildRetellAgentConfig(input: RetellAgentConfigInput) {
  return {
    response_engine: { type: 'retell-llm' as const, llm_id: input.llmId },
    voice_id: input.voiceId,
    voice_model: input.voiceModel ?? 'eleven_v3_conversational',
    agent_name: input.agentName ?? 'Blaze Estate — Avery',
    webhook_url: input.webhookUrl,
    language: 'en-US' as const,

    // Pacing and turn-taking tuned for a real phone conversation, not a kiosk voice.
    voice_speed: 0.98,
    voice_temperature: 1,
    enable_dynamic_voice_speed: true,
    enable_dynamic_responsiveness: true,
    responsiveness: 1,
    interruption_sensitivity: 0.75,

    // The single biggest lever for "sounds human": Avery reacts while the caller is still talking.
    enable_backchannel: true,
    backchannel_frequency: 0.8,
    backchannel_words: ['mm-hmm', 'I see', 'got it', 'right', 'sure'],

    enable_expressive_mode: true,
    expressive_emotion_tags: ['empathetic', 'excited', 'pause'] as const,
    expressive_mode_prompt: 'Use [empathetic] for budget or hesitation moments, [excited] when a match sounds promising, and [pause] before a considered reply — sparingly, a few times per call at most.',

    reminder_trigger_ms: 10000,
    reminder_max_count: 1,

    // No ambient sound: a real-estate agency call reading as staged background noise undercuts trust, not adds it.
    max_call_duration_ms: 20 * 60 * 1000,
    end_call_after_silence_ms: 5 * 60 * 1000,

    boosted_keywords: ['Blaze Estate', 'BlazeReach'],

    // Retell's generic naturalness layer, kept alongside (not instead of) the prompt above.
    handbook_config: {
      default_personality: false,
      conversational_personality: true,
      natural_filler_words: true,
      high_empathy: true,
      echo_verification: true,
      nato_phonetic_alphabet: true,
      speech_normalization: true,
      smart_matching: true,
      ai_disclosure: true,
      scope_boundaries: true,
    },
  };
}
