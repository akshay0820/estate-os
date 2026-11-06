import { describe, expect, it } from 'vitest';
import { buildRetellAgentConfig, buildRetellLlmConfig, BLAZE_ESTATE_GENERAL_PROMPT, DEFAULT_DYNAMIC_VARIABLES, DYNAMIC_VARIABLE_NAMES } from '../../supabase/functions/_shared/retell-agent-config';

describe('Retell LLM config', () => {
  it('ships the persona prompt and one default per dynamic variable voice_call_dispatch fills in', () => {
    const cfg = buildRetellLlmConfig();
    expect(cfg.general_prompt).toBe(BLAZE_ESTATE_GENERAL_PROMPT);
    expect(Object.keys(cfg.default_dynamic_variables).sort()).toEqual([...DYNAMIC_VARIABLE_NAMES].sort());
    expect(cfg.default_dynamic_variables).toEqual(DEFAULT_DYNAMIC_VARIABLES);
  });

  it('every dynamic variable the prompt references is one voice_call_dispatch actually fills in', () => {
    const referenced = [...BLAZE_ESTATE_GENERAL_PROMPT.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) expect(DYNAMIC_VARIABLE_NAMES).toContain(name);
  });

  it('discloses it is an AI, never claims to be human, and never invents listing specifics', () => {
    const p = BLAZE_ESTATE_GENERAL_PROMPT.toLowerCase();
    expect(p).toContain("you're an ai assistant");
    expect(p).toContain('always say no');
    expect(p).toContain('never invent or guarantee');
  });

  it('honours an immediate opt-out instead of trying to re-engage', () => {
    expect(BLAZE_ESTATE_GENERAL_PROMPT.toLowerCase()).toContain('never try to re-engage after an opt-out');
  });

  it('never claims to book, schedule or confirm anything itself — no mid-call tool exists for that (docs/agents/AGENT_02_VOICE_CALLING_IMPLEMENTATION.md §15)', () => {
    const p = BLAZE_ESTATE_GENERAL_PROMPT.toLowerCase();
    expect(p).toContain('cannot book, schedule, or confirm anything yourself');
    expect(p).toContain('never say or imply that a viewing has been booked');
  });

  it('gives end_call to the model so a finished or opted-out call actually ends', () => {
    const cfg = buildRetellLlmConfig();
    expect(cfg.general_tools).toEqual([{ type: 'end_call', name: 'end_call', description: expect.any(String) }]);
  });

  it('omits begin_message so the opener adapts to a blank customer_first_name', () => {
    expect(buildRetellLlmConfig()).not.toHaveProperty('begin_message');
  });

  it('passes an existing llm_id through unchanged for an update call (the shape stays identical; the caller picks the URL)', () => {
    expect(buildRetellLlmConfig({ llmId: 'llm_existing_123' })).toEqual(buildRetellLlmConfig());
  });
});

describe('Retell agent config', () => {
  const base = { llmId: 'llm_abc123', voiceId: '11labs-Adrian', webhookUrl: 'https://example.supabase.co/functions/v1/voice-webhook' };

  it('wires the response engine to the given LLM and voice', () => {
    const cfg = buildRetellAgentConfig(base);
    expect(cfg.response_engine).toEqual({ type: 'retell-llm', llm_id: base.llmId });
    expect(cfg.voice_id).toBe(base.voiceId);
    expect(cfg.webhook_url).toBe(base.webhookUrl);
  });

  it('defaults the voice model and agent name, and lets both be overridden', () => {
    expect(buildRetellAgentConfig(base).voice_model).toBe('eleven_v3_conversational');
    expect(buildRetellAgentConfig(base).agent_name).toBe('Blaze Estate — Avery');
    expect(buildRetellAgentConfig({ ...base, voiceModel: 'sonic-3', agentName: 'Custom' }).voice_model).toBe('sonic-3');
    expect(buildRetellAgentConfig({ ...base, agentName: 'Custom' }).agent_name).toBe('Custom');
  });

  it('enables backchanneling and dynamic pacing — the levers that most change how human a call sounds', () => {
    const cfg = buildRetellAgentConfig(base);
    expect(cfg.enable_backchannel).toBe(true);
    expect(cfg.enable_dynamic_voice_speed).toBe(true);
    expect(cfg.enable_dynamic_responsiveness).toBe(true);
    expect(cfg.interruption_sensitivity).toBeGreaterThan(0);
    expect(cfg.interruption_sensitivity).toBeLessThanOrEqual(1);
  });

  it('declares its own persona over Retell\'s generic one, and turns on AI disclosure', () => {
    const cfg = buildRetellAgentConfig(base);
    expect(cfg.handbook_config.default_personality).toBe(false);
    expect(cfg.handbook_config.ai_disclosure).toBe(true);
  });

  it('caps call length and silence so a stuck call cannot run (and bill) forever', () => {
    const cfg = buildRetellAgentConfig(base);
    expect(cfg.max_call_duration_ms).toBeGreaterThan(0);
    expect(cfg.end_call_after_silence_ms).toBeGreaterThan(0);
  });

  it('leaves ambient sound off', () => {
    expect(buildRetellAgentConfig(base)).not.toHaveProperty('ambient_sound');
  });
});
