// analyze-call: a signed-in team member uploads a call recording or pastes a transcript.
// The call is transcribed (if audio), scored, and saved to public.calls.
// Agents can only add calls under their own agent name; managers can add for anyone.
import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const USE_OPENAI = !!env("OPENAI_API_KEY");
const AI_BASE = USE_OPENAI ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";
const AI_KEY = () => env("OPENAI_API_KEY") || env("GROQ_API_KEY");
const TRANSCRIBE_MODELS = env("TRANSCRIBE_MODEL", USE_OPENAI ? "gpt-4o-transcribe-diarize,gpt-transcribe,gpt-4o-transcribe" : "whisper-large-v3-turbo,whisper-large-v3").split(",").map((s) => s.trim());
const ANALYSIS_MODELS = env("ANALYSIS_MODEL", USE_OPENAI ? "gpt-5.6-sol,gpt-4o" : "openai/gpt-oss-120b,llama-3.3-70b-versatile").split(",").map((s) => s.trim());

const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function transcribe(file: File): Promise<{ text: string; model: string }> {
  let lastErr = "";
  for (const model of TRANSCRIBE_MODELS) {
    const fd = new FormData();
    fd.append("file", file, file.name || "call.mp3");
    fd.append("model", model);
    const diarize = model.includes("diarize");
    if (diarize) { fd.append("response_format", "diarized_json"); fd.append("chunking_strategy", "auto"); }
    else fd.append("response_format", "json");
    const r = await fetch(`${AI_BASE}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${AI_KEY()}` }, body: fd });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      if (diarize && Array.isArray(d.segments) && d.segments.length) {
        const lines: string[] = [];
        for (const s of d.segments) {
          const who = `Speaker ${s.speaker ?? "?"}`;
          const t = String(s.text ?? "").trim();
          if (!t) continue;
          if (lines.length && lines[lines.length - 1].startsWith(who + ":")) lines[lines.length - 1] += " " + t;
          else lines.push(`${who}: ${t}`);
        }
        return { text: lines.join("\n"), model };
      }
      if (d.text) return { text: String(d.text), model };
    }
    lastErr = `${model}: ${r.status} ${d.error?.message ?? ""}`;
    if (r.status === 401 || r.status === 429) break;
  }
  throw new Error(`Transcription failed — ${lastErr}`);
}

const STAGES = ["Opener", "Reason for call", "Discovery questions", "Value pitch", "Objection handling", "Close / next step", "Lock-in (paperwork)", "Tone & confidence"];

function coachPrompt(agent: string, transcript: string) {
  return `You are a strict but fair sales coach for a US truck dispatch company. Its sales agents call owner-operators and small trucking carriers (often new MC authorities) to sign them up for dispatch service (the company finds loads, negotiates rates with brokers, handles paperwork, and charges a % of each load).

The company's call process:
1. Opener: confirm name, introduce self, ask permission for 60 seconds.
2. Reason for call: short, about the carrier (e.g. new authority), not a company brochure.
3. Discovery: truck/trailer type, preferred lanes, how they find loads now, current rate per mile, time spent on brokers, empty days. Carrier should talk ~60% of the time.
4. Value pitch: tie benefits to the carrier's own answers, in dollars per mile / per week.
5. Objection handling: agree first, then turn it into a question; offer proof; never argue or make generic "we are the best" claims.
6. Close: low-risk next step (book one load together / trial week / callback at a specific time).
7. Lock-in: ask for MC number, W-9, insurance certificate, void check; send agreement.
8. Tone & confidence: clear, friendly, confident, not robotic or pushy.

This call was handled by sales agent "${agent}". The transcript may be machine-generated; speakers may be labelled "Speaker A/B" or not at all — work out which speaker is the agent. If the call is not a sales conversation (voicemail, wrong number, support, personal), set "outcome" to "Not a sales call", "overall" to 0 and keep the other fields short.

Score each stage 0-10 (0 and note "Not reached" if the call never got there). Quote the agent's actual words. "better" lines must be natural spoken English the agent can say word-for-word next time, specific to this carrier.

Return ONLY a JSON object with exactly this shape:
{"overall": integer 0-100,
"outcome": one of "Signed","Trial / first load booked","Callback scheduled","Info sent, no next step","Not interested","Hung up","Voicemail","Not a sales call",
"summary": "2 short sentences: what happened and the single biggest reason for the result",
"agentTalkPercent": integer 0-100 estimate,
"carrierName": "carrier or company name if said, else empty",
"stages": [${STAGES.map((s) => `{"name":"${s}","score":0,"note":"one short sentence"}`).join(",")}],
"mistakes": [{"quote":"agent's exact words","problem":"why it hurt the sale","better":"what to say instead","severity":"high|medium|low"}] (1-6 items, most costly first),
"objections": [{"objection":"carrier's words","agentResponse":"what agent said","betterResponse":"ideal reply"}],
"strengths": ["short item"] (0-3),
"missed": ["missed opportunity"] (1-4),
"drill": "one specific practice exercise for this agent before tomorrow's calls"}

TRANSCRIPT:
"""
${transcript.slice(0, 60000)}
"""`;
}

async function analyze(agent: string, transcript: string): Promise<{ result: any; model: string }> {
  let lastErr = "";
  for (const model of ANALYSIS_MODELS) {
    const isNew = USE_OPENAI && /^gpt-5|^o\d/.test(model);
    const body: Record<string, unknown> = { model, messages: [{ role: "user", content: coachPrompt(agent, transcript) }], response_format: { type: "json_object" } };
    if (isNew) body.max_completion_tokens = 6000; else { body.max_tokens = 3000; body.temperature = 0.2; }
    const r = await fetch(`${AI_BASE}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${AI_KEY()}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      try {
        const res = JSON.parse(d.choices?.[0]?.message?.content ?? "");
        if (res && Array.isArray(res.stages)) return { result: res, model };
        lastErr = `${model}: incomplete JSON`;
      } catch { lastErr = `${model}: could not parse JSON`; }
    } else {
      lastErr = `${model}: ${r.status} ${d.error?.message ?? ""}`;
      if (r.status === 401 || r.status === 429) break;
    }
  }
  throw new Error(`Analysis failed — ${lastErr}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // who is calling?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(token);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return json({ error: "Please sign in again." }, 401);
  const { data: member } = await admin.from("team_members").select("*").ilike("email", email).maybeSingle();
  if (!member) return json({ error: "You do not have access to Call Coach yet. Ask your manager to add you." }, 403);
  if (!AI_KEY()) return json({ error: "AI is not set up yet: add GROQ_API_KEY (free) or OPENAI_API_KEY in Supabase Edge Function secrets." }, 503);

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "Could not read the upload." }, 400); }
  const file = form.get("file");
  let transcript = String(form.get("transcript") ?? "").trim();
  const carrier = String(form.get("carrier") ?? "").trim().slice(0, 120) || null;
  const durationSec = Math.max(0, Math.round(Number(form.get("duration") ?? 0))) || null;
  let agent = String(form.get("agent") ?? "").trim().slice(0, 120);
  if (member.role !== "manager") agent = member.agent_name || email;
  if (!agent) return json({ error: "Choose the agent who made this call." }, 400);

  try {
    let tModel = "pasted";
    let audioPath: string | null = null;
    if (file instanceof File && file.size > 0) {
      if (file.size > 24 * 1024 * 1024) return json({ error: "Recording is larger than 24 MB. Upload a shorter call or an mp3." }, 413);
      const tx = await transcribe(file);
      transcript = tx.text; tModel = tx.model;
      const ext = (file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "mp3";
      const path = `uploads/${crypto.randomUUID()}.${ext}`;
      const up = await admin.storage.from("recordings").upload(path, file, { contentType: file.type || "audio/mpeg" });
      if (!up.error) audioPath = path;
    }
    if (transcript.length < 80) return json({ error: "The call is too short to review. Paste a longer transcript or a longer recording." }, 400);

    const an = await analyze(agent, transcript);
    const r = an.result;
    const { data: row, error } = await admin.from("calls").insert({
      rc_call_id: `manual-${crypto.randomUUID()}`,
      started_at: new Date().toISOString(),
      duration_sec: durationSec,
      direction: file instanceof File && file.size > 0 ? "Uploaded recording" : "Pasted transcript",
      agent_name: agent,
      carrier_name: carrier || (r.carrierName ? String(r.carrierName).slice(0, 120) : null),
      status: "done",
      audio_path: audioPath,
      transcript,
      result: { ...r, _models: { transcribe: tModel, analysis: an.model }, _addedBy: email },
      overall: Math.max(0, Math.min(100, Math.round(Number(r.overall) || 0))),
      outcome: String(r.outcome ?? ""),
    }).select("id").single();
    if (error) throw new Error(`Could not save: ${error.message}`);
    return json({ ok: true, id: row.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = /429/.test(msg) ? "The free AI limit is reached for now. Try again in a few minutes." : /401/.test(msg) ? "The AI key in Supabase is not valid. Check GROQ_API_KEY." : msg;
    return json({ error: friendly }, 500);
  }
});
