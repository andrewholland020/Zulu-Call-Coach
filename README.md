# Zulu Call Coach

Automatic AI review of RingCentral sales calls.

Every 5 minutes a Supabase Edge Function (`rc-sync`) pulls new recorded calls from RingCentral, transcribes them with AI (Groq free tier, or OpenAI), scores them against the sales process, and saves the result. The dashboard (`index.html`, hosted on GitHub Pages) shows each call's score, the lines that lost the sale, better replies, and a team scoreboard.

## Parts

| Part | Where |
| --- | --- |
| Database, schedule, sync function | Supabase project `Call-Coach` (`wapxbphxzdmfqnourkqs`) |
| Sync function source | `supabase/functions/rc-sync/index.ts` |
| Manual upload function | `supabase/functions/analyze-call/index.ts` (Add a call tab: upload a recording or paste a transcript) |
| Dashboard | `index.html` (GitHub Pages) |

## One-time setup

1. **RingCentral recording:** Admin Portal → turn on Automatic Call Recording for sales agents (keep the recording announcement on).
2. **RingCentral app:** developers.ringcentral.com → Register App → REST API App, JWT auth flow, permissions: Read Accounts, Read Call Log, Read Call Recording. Create a JWT credential while signed in as an **admin** user.
3. **AI key:** console.groq.com → API Keys → Create (free). Or, for higher volume/accuracy, platform.openai.com → billing → API key.
4. **Supabase secrets:** Supabase → project Call-Coach → Edge Functions → Secrets. Add:
   - `RC_CLIENT_ID`
   - `RC_CLIENT_SECRET`
   - `RC_JWT`
   - `GROQ_API_KEY` (free) **or** `OPENAI_API_KEY` (if both are set, OpenAI is used)
5. **Logins:** Supabase → Authentication → Users → Add user (Auto confirm on). Then add the person in the dashboard under Team access. Agents need their exact RingCentral name.
6. Recommended: Supabase → Authentication → Sign In / Providers → turn off "Allow new users to sign up".

## Optional settings (Edge Function secrets)

| Secret | Default | Meaning |
| --- | --- | --- |
| `MIN_CALL_SECONDS` | 45 | Calls shorter than this are skipped |
| `DIRECTIONS` | Outbound,Inbound | Which calls to review |
| `BATCH_SIZE` | 3 | Calls reviewed per 5-minute run |
| `TRANSCRIBE_MODEL` | Groq: whisper-large-v3-turbo,whisper-large-v3 · OpenAI: gpt-4o-transcribe-diarize,gpt-transcribe,gpt-4o-transcribe | Tried in order |
| `ANALYSIS_MODEL` | Groq: openai/gpt-oss-120b,llama-3.3-70b-versatile · OpenAI: gpt-5.6-sol,gpt-4o | Tried in order |
| `RC_SERVER` | https://platform.ringcentral.com | Use the devtest URL for a sandbox app |

Sync status and the last error show at the top of the dashboard for managers.

Groq free tier limits audio to roughly 8 hours a day (about 90 five-minute calls). Calls over the limit wait and are reviewed later.
