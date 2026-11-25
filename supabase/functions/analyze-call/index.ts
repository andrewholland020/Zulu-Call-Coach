// analyze-call: a signed-in team member uploads a call recording or pastes a transcript.
// The call is transcribed (if audio), scored, and saved to public.calls.
// Agents can only add calls under their own agent name; managers can add for anyone.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
// Provider order: Gemini (GEMINI_API_KEY), then OpenAI, then Groq.
const USE_GEMINI = !!env("GEMINI_API_KEY");
const GEMINI_MODELS = env("GEMINI_MODEL", "gemini-flash-latest,gemini-flash-lite-latest,gemini-2.5-flash").split(",").map((s) => s.trim());
const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const USE_OPENAI = !!env("OPENAI_API_KEY");
const AI_BASE = USE_OPENAI ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";
const AI_KEY = () => env("OPENAI_API_KEY") || env("GROQ_API_KEY");
const ANY_KEY = () => env("GEMINI_API_KEY") || AI_KEY();
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

// One Gemini request with little "thinking" (much faster) and a time limit, so a slow model gives way to the next.
async function geminiCall(model: string, parts: unknown[], maxTokens: number, timeoutMs: number) {
  const thinking = /2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "low" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const gen: Record<string, unknown> = { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: maxTokens };
    if (attempt === 0) gen.thinkingConfig = thinking;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
        method: "POST", signal: ctl.signal,
        headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: gen }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && r.status === 400 && attempt === 0 && /think/i.test(d.error?.message ?? "")) continue; // model does not take this setting
      return { ok: r.ok, status: r.status, d };
    } catch (e) {
      return { ok: false, status: 504, d: { error: { message: e instanceof Error && e.name === "AbortError" ? `took longer than ${timeoutMs / 1000}s` : String(e) } } };
    } finally { clearTimeout(t); }
  }
  return { ok: false, status: 400, d: { error: { message: "request rejected" } } };
}

// ---------- Gemini: one call listens to the audio (or reads the transcript) and reviews it ----------
async function geminiUpload(file: File): Promise<{ uri: string; mime: string }> {
  const mime = file.type || "audio/mpeg";
  const start = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": env("GEMINI_API_KEY"), "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.size), "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "call" } }),
  });
  const url = start.headers.get("x-goog-upload-url");
  if (!start.ok || !url) throw new Error(`Gemini upload failed (${start.status})`);
  const up = await fetch(url, {
    method: "POST",
    headers: { "Content-Length": String(file.size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: file,
  });
  const d = await up.json().catch(() => ({}));
  let f = d.file;
  if (!up.ok || !f?.uri) throw new Error(`Gemini upload failed (${up.status})`);
  for (let i = 0; i < 20 && f.state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const g = await fetch(`${GEMINI_BASE}/v1beta/${f.name}`, { headers: { "x-goog-api-key": env("GEMINI_API_KEY") } });
    f = await g.json().catch(() => f);
  }
  if (f.state === "FAILED") throw new Error("Gemini could not read this audio file");
  return { uri: f.uri, mime: f.mimeType || mime };
}

async function geminiReview(agent: string, transcript: string, file: File | null): Promise<{ result: any; model: string; transcript: string }> {
  const parts: unknown[] = [];
  let prompt = coachPrompt(agent, file ? "(The call is attached as an audio recording.)" : transcript);
  if (file) {
    prompt += `\n\nThe call is attached as audio. Listen to all of it. Add a "transcript" field to the JSON with the full conversation, one turn per line, each line starting with "Agent:" or "Carrier:". Base the review on what was actually said.`;
    if (file.size <= 14 * 1024 * 1024) parts.push({ inline_data: { mime_type: file.type || "audio/mpeg", data: encodeBase64(new Uint8Array(await file.arrayBuffer())) } });
    else { const f = await geminiUpload(file); parts.push({ file_data: { mime_type: f.mime, file_uri: f.uri } }); }
  }
  parts.unshift({ text: prompt });
  let lastErr = "";
  const started = Date.now();
  for (const [i, model] of GEMINI_MODELS.entries()) {
    const left = 135_000 - (Date.now() - started);
    if (left < 15_000) break;
    const budget = i === GEMINI_MODELS.length - 1 ? left : Math.min(left, 65_000);
    const { ok, status, d } = await geminiCall(model, parts, 8192, budget);
    const r = { ok, status };
    if (r.ok) {
      const text = (d.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      try {
        const res = JSON.parse(text.replace(/^```(json)?|```$/g, "").trim());
        if (res && Array.isArray(res.stages)) {
          const tx = file ? String(res.transcript ?? "").trim() : transcript;
          delete res.transcript;
          return { result: res, model, transcript: tx };
        }
        lastErr = `${model}: incomplete JSON`;
      } catch { lastErr = `${model}: could not parse JSON`; }
    } else {
      lastErr = `${model}: ${r.status} ${d.error?.message ?? ""}`;
      if (r.status === 400 && /API key/i.test(d.error?.message ?? "")) throw new Error("401 Gemini API key is not valid");
      // 404 = model not available, 429 = that model's free quota used up: try the next model
    }
  }
  throw new Error(`Review failed — ${lastErr}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // who is calling? (the scheduler's secret allows a dry-run health check that saves nothing)
  const secret = req.headers.get("x-sync-secret") ?? "";
  const dryRun = secret ? !!(await admin.rpc("check_sync_secret", { s: secret })).data : false;
  let email = "health-check", member: { role: string; agent_name?: string } | null = { role: "manager" };
  if (!dryRun) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    email = u?.user?.email?.toLowerCase() ?? "";
    if (!email) return json({ error: "Please sign in again." }, 401);
    member = (await admin.from("team_members").select("*").ilike("email", email).maybeSingle()).data;
    if (!member) return json({ error: "You do not have access to Call Coach yet. Ask your manager to add you." }, 403);
  }
  if (!ANY_KEY()) return json({ error: "AI is not set up yet: add GEMINI_API_KEY (free) in Supabase Edge Function secrets." }, 503);

  let form: FormData;
  try {
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const body = await req.json(); form = new FormData();
      for (const k of ["transcript", "agent", "carrier"]) if (body[k]) form.append(k, String(body[k]));
    } else form = await req.formData();
  } catch { return json({ error: "Could not read the upload." }, 400); }
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
    const audio = file instanceof File && file.size > 0 ? file : null;
    const hasFile = audio !== null;
    if (audio && audio.size > 24 * 1024 * 1024) return json({ error: "Recording is larger than 24 MB. Upload a shorter call or an mp3." }, 413);
    if (!hasFile && transcript.length < 80) return json({ error: "The call is too short to review. Paste a longer transcript or a longer recording." }, 400);
    let an: { result: any; model: string };
    if (USE_GEMINI) {
      const g = await geminiReview(agent, transcript, audio);
      an = g; transcript = g.transcript; if (hasFile) tModel = g.model;
    } else {
      if (audio) { const tx = await transcribe(audio); transcript = tx.text; tModel = tx.model; }
      if (transcript.length < 80) return json({ error: "The call is too short to review. Paste a longer transcript or a longer recording." }, 400);
      an = await analyze(agent, transcript);
    }
    if (dryRun) return json({ ok: true, dryRun: true, model: an.model, overall: an.result.overall, outcome: an.result.outcome, summary: an.result.summary });
    if (audio) {
      const ext = (audio.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "mp3";
      const path = `uploads/${crypto.randomUUID()}.${ext}`;
      const up = await admin.storage.from("recordings").upload(path, audio, { contentType: audio.type || "audio/mpeg" });
      if (!up.error) audioPath = path;
    }
    const r = an.result;
    const { data: row, error } = await admin.from("calls").insert({
      rc_call_id: `manual-${crypto.randomUUID()}`,
      started_at: new Date().toISOString(),
      duration_sec: durationSec,
      direction: hasFile ? "Uploaded recording" : "Pasted transcript",
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
    const friendly = /429/.test(msg) ? "The free AI limit is reached for now. Try again in a few minutes." : /401/.test(msg) ? "The AI key in Supabase is not valid. Check GEMINI_API_KEY." : msg;
    return json({ error: friendly }, 500);
  }
});
