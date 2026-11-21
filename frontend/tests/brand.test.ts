import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND as client } from '../src/brand';
import { BRAND as server } from '../../supabase/functions/_shared/brand';
import { buildRetellAgentConfig, BLAZE_ESTATE_GENERAL_PROMPT, DEFAULT_DYNAMIC_VARIABLES } from '../../supabase/functions/_shared/retell-agent-config';
import { systemPrompt } from '../../supabase/functions/_shared/assistant';

// A client deployment renames the product in src/brand.ts and supabase/functions/_shared/brand.ts; these keep the two
// copies identical and prove the names actually reach every surface that shows them.
describe('brand config', () => {
  it('frontend and Edge Function copies are identical', () => {
    expect(server).toEqual(client);
  });

  it('every field is a trimmed string and the product name is set', () => {
    for (const [k, v] of Object.entries(client)) expect(v, k).toBe(v.trim());
    expect(client.productName.length).toBeGreaterThan(0);
  });

  it('flows into the voice persona and the assistant prompt', () => {
    expect(BLAZE_ESTATE_GENERAL_PROMPT.startsWith(`You are ${client.voiceAgentName},`)).toBe(true);
    expect(DEFAULT_DYNAMIC_VARIABLES.agency_name).toBe(client.agencyName);
    const agent = buildRetellAgentConfig({ llmId: 'llm', voiceId: 'v', webhookUrl: 'https://x/y' });
    expect(agent.agent_name).toBe(`${client.agencyName} — ${client.voiceAgentName}`);
    expect(agent.boosted_keywords).toContain(client.agencyName);
    const prompt = systemPrompt({ orgName: 'Acme', userName: 'Sam', role: 'agent', timezone: 'UTC', currency: 'USD', nowIso: '', localNow: '' });
    expect(prompt).toContain(`You are the ${client.productName} assistant for Acme`);
  });

  it('index.html takes its title from the brand file', () => {
    const html = readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    expect(html).toContain('<title>%BRAND_TITLE%</title>');
  });
});
