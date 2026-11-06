// Pushes Blaze Estate's voice persona (supabase/functions/_shared/retell-agent-config.ts) to Retell as a real
// LLM + Agent, instead of hand-editing it in the Retell dashboard. This calls Retell's live, billed API — it only
// runs when an operator supplies RETELL_API_KEY and a real --voice-id.
//
// Usage (from frontend/):
//   RETELL_API_KEY=key_... node scripts/sync-retell-agent.mjs --voice-id 11labs-Adrian [options]
//
// Options:
//   --voice-id <id>        required. Pick one from the Retell dashboard's Voices tab (preview it there first).
//   --voice-model <name>   optional. Must match the voice's TTS provider; default assumes an ElevenLabs voice.
//   --webhook-url <url>    optional. Default: <VITE_SUPABASE_URL from .env.local>/functions/v1/voice-webhook
//   --llm-id <id>          optional. Update this existing Retell LLM instead of creating a new one.
//   --agent-id <id>        optional. Update this existing Retell agent instead of creating a new one.
//   --agent-name <name>    optional. Defaults to "Blaze Estate — Avery".
//
// On success, paste the printed agent_id into Estate OS → Settings → AI Voice Calling as outbound_agent_id (and
// inbound_agent_id, if this is also the inbound agent) — the app's own voice_settings_save RPC owns that, not this
// script. Running this again with --llm-id/--agent-id updates the same agent in place; omitting them always
// creates a new one.
import { readFileSync, existsSync } from 'node:fs';
import { buildRetellAgentConfig, buildRetellLlmConfig, RETELL_PERSONA_VERSION } from '../../supabase/functions/_shared/retell-agent-config.ts';

const RETELL_BASE = 'https://api.retellai.com';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const apiKey = process.env.RETELL_API_KEY;
if (!apiKey) { console.error('Refusing to run: set RETELL_API_KEY (a real, billed Retell credential — never store it in a file in this repo).'); process.exit(2); }
if (!args['voice-id']) { console.error('Refusing to run: --voice-id is required. Preview voices in the Retell dashboard and pass one.'); process.exit(2); }

let webhookUrl = args['webhook-url'];
if (!webhookUrl) {
  const envPath = new URL('../.env.local', import.meta.url);
  if (!existsSync(envPath)) { console.error('No --webhook-url given and frontend/.env.local does not exist to derive one from.'); process.exit(2); }
  const env = Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  if (!env.VITE_SUPABASE_URL) { console.error('No --webhook-url given and VITE_SUPABASE_URL is not set in frontend/.env.local.'); process.exit(2); }
  webhookUrl = `${env.VITE_SUPABASE_URL}/functions/v1/voice-webhook`;
}

async function call(path, body) {
  const res = await fetch(`${RETELL_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Retell ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

try {
  console.log(`Syncing persona ${RETELL_PERSONA_VERSION}…`);

  const llmBody = buildRetellLlmConfig({ llmId: args['llm-id'] });
  const llmPath = args['llm-id'] ? `/update-retell-llm/${args['llm-id']}` : '/create-retell-llm';
  const llm = await call(llmPath, llmBody);
  console.log(`${args['llm-id'] ? 'Updated' : 'Created'} Retell LLM: ${llm.llm_id}`);

  const agentBody = buildRetellAgentConfig({
    llmId: llm.llm_id,
    voiceId: args['voice-id'],
    voiceModel: args['voice-model'],
    webhookUrl,
    agentName: args['agent-name'],
  });
  const agentPath = args['agent-id'] ? `/update-agent/${args['agent-id']}` : '/create-agent';
  const agent = await call(agentPath, agentBody);
  console.log(`${args['agent-id'] ? 'Updated' : 'Created'} Retell agent: ${agent.agent_id}`);
  console.log('\nNext: in Estate OS → Settings → AI Voice Calling, set this as the outbound (and/or inbound) agent id.');
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
