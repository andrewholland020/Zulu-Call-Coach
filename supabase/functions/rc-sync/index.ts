// rc-sync: pulls recorded calls from RingCentral, transcribes them with AI (Groq or OpenAI),
// scores them as sales calls, and stores the result in public.calls.
// Called every 5 minutes by pg_cron with the x-sync-secret header.
import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const RC_SERVER = env("RC_SERVER", "https://platform.ringcentral.com");
const MIN_SEC = Number(env("MIN_CALL_SECONDS", "45"));
const BATCH = Number(env("BATCH_SIZE", "3"));
const DIRECTIONS = env("DIRECTIONS", "Outbound,Inbound").split(",").map((s) => s.trim());
// Provider: OpenAI if OPENAI_API_KEY is set, otherwise Groq (free tier) with GROQ_API_KEY.
const USE_OPENAI = !!env("OPENAI_API_KEY");
const AI_BASE = USE_OPENAI ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";
const AI_KEY = () => env("OPENAI_API_KEY") || env("GROQ_API_KEY");
const TRANSCRIBE_MODELS = env("TRANSCRIBE_MODEL", USE_OPENAI ? "gpt-4o-transcribe-diarize,gpt-transcribe,gpt-4o-transcribe" : "whisper-large-v3-turbo,whisper-large-v3").split(",").map((s) => s.trim());
const ANALYSIS_MODELS = env("ANALYSIS_MODEL", USE_OPENAI ? "gpt-5.6-sol,gpt-4o" : "openai/gpt-oss-120b,llama-3.3-70b-versatile").split(",").map((s) => s.trim());
const TIME_BUDGET_MS = 110_000;

const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function setState(key: string, value: string) {
  await sb.from("sync_state").upsert({ key, value, updated_at: new Date().toISOString() });
}
async function getState(key: string) {
  const { data } = await sb.from("sync_state").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

// ---------- RingCentral ----------
async function rcToken(): Promise<string> {
  const basic = btoa(`${env("RC_CLIENT_ID")}:${env("RC_CLIENT_SECRET")}`);
  const r = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: env("RC_JWT") }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`RingCentral login failed (${r.status}): ${t.error_description || t.message || "check RC_CLIENT_ID, RC_CLIENT_SECRET and RC_JWT"}`);
  return t.access_token;
}

async function syncCallLog(token: string): Promise<number> {
  const now = new Date();
  const last = await getState("call_log_synced_to");
  const from = last ? new Date(new Date(last).getTime() - 30 * 60_000) : new Date(now.getTime() - 24 * 3600_000);
  let url: string | null = `${RC_SERVER}/restapi/v1.0/account/~/call-log?` + new URLSearchParams({
    dateFrom: from.toISOString(), dateTo: now.toISOString(), type: "Voice", withRecording: "true", view: "Simple", perPage: "250",
  });
  let added = 0, pages = 0;
  while (url && pages < 5) {
    pages++;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`RingCentral call log failed (${r.status}): ${d.message || ""} — the app needs Read Call Log, and the JWT must belong to an admin user`);
    const rows = [];
    for (const c of d.records ?? []) {
      if (!c.recording?.contentUri || !DIRECTIONS.includes(c.direction)) continue;
      const out = c.direction === "Outbound";
      const agent = out ? c.from : c.to;
      const carrier = out ? c.to : c.from;
      rows.push({
        rc_call_id: String(c.id),
        rc_recording_id: String(c.recording.id ?? ""),
        recording_uri: c.recording.contentUri,
        started_at: c.startTime,
        duration_sec: c.duration ?? 0,
        direction: c.direction,
        agent_name: agent?.name || (agent?.extensionNumber ? `Ext ${agent.extensionNumber}` : null) || (c.extension?.id ? `Ext ${c.extension.id}` : "Unknown"),
        agent_ext: agent?.extensionNumber ?? (c.extension?.id ? String(c.extension.id) : null),
        carrier_number: carrier?.phoneNumber ?? null,
        carrier_name: carrier?.name ?? null,
        status: (c.duration ?? 0) < MIN_SEC ? "skipped" : "queued",
        error: (c.duration ?? 0) < MIN_SEC ? `Shorter than ${MIN_SEC} seconds` : null,
      });
    }
    if (rows.length) {
      const { data, error } = await sb.from("calls").upsert(rows, { onConflict: "rc_call_id", ignoreDuplicates: true }).select("id");
      if (error) throw new Error(`Database insert failed: ${error.message}`);
      added += data?.length ?? 0;
    }
    url = d.navigation?.nextPage?.uri ?? null;
  }
  await setState("call_log_synced_to", now.toISOString());
  return added;
}

async function downloadRecording(uri: string, token: string): Promise<{ blob: Blob; name: string }> {
  const r = await fetch(uri, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Recording download failed (${r.status}) — the app needs Read Call Recording`);
  const type = r.headers.get("content-type") ?? "audio/mpeg";
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 24 * 1024 * 1024) throw new Error("Recording is larger than 24 MB; too long to transcribe");
  const ext = type.includes("wav") ? "wav" : "mp3";
  return { blob: new Blob([buf], { type }), name: `call.${ext}` };
}

// ---------- OpenAI ----------
async function transcribe(blob: Blob, name: string): Promise<{ text: string; model: string }> {
  let lastErr = "";
  for (const model of TRANSCRIBE_MODELS) {
    const fd = new FormData();
    fd.append("file", blob, name);
    fd.append("model", model);
    const diarize = model.includes("diarize");
    if (diarize) { fd.append("response_format", "diarized_json"); fd.append("chunking_strategy", "auto"); }
    else fd.append("response_format", "json");
    const r = await fetch(`${AI_BASE}/audio/transcriptions`, {
      method: "POST", headers: { Authorization: `Bearer ${AI_KEY()}` }, body: fd,
    });
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
    if (r.status === 401 || r.status === 429) break; // bad key or quota: other models won't help
  }
  throw new Error(`Transcription failed — ${lastErr}`);
}

const STAGES = ["Opener", "Reason for call", "Discovery questions", "Value pitch", "Objection handling", "Close / next step", "Lock-in (paperwork)", "Tone & confidence"];

function coachPrompt(agent: string, direction: string, transcript: string) {
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

This is a ${direction.toLowerCase()} call handled by sales agent "${agent}". The transcript was machine-generated from a phone recording; speakers may be labelled "Speaker A/B" or not at all — work out which speaker is the agent. If the call is not a sales conversation (voicemail, wrong number, existing customer support, personal call), set "outcome" to "Not a sales call", "overall" to 0 and keep the other fields short.

Score each stage 0-10 (0 and note "Not reached" if the call never got there). Quote the agent's actual words. "better" lines must be natural spoken English the agent can say word-for-word next time, specific to this carrier.

Return ONLY a JSON object with exactly this shape:
{"overall": integer 0-100,
"outcome": one of "Signed","Trial / first load booked","Callback scheduled","Info sent, no next step","Not interested","Hung up","Voicemail","Not a sales call",
"summary": "2 short sentences: what happened and the single biggest reason for the result",
"agentTalkPercent": integer 0-100 estimate,
"carrierName": "carrier or company name if said, else empty",
"stages": [${STAGES.map((s) => `{"name":"${s}","score":0,"note":"one short sentence"}`).join(",")}],
"mistakes": [{"quote":"agent's exact words","problem":"why it hurt the sale","better":"what to say instead","severity":"high|medium|low"}] (3-6 items, most costly first),
"objections": [{"objection":"carrier's words","agentResponse":"what agent said","betterResponse":"ideal reply"}],
"strengths": ["short item"] (0-3),
"missed": ["missed opportunity"] (1-4),
"drill": "one specific practice exercise for this agent before tomorrow's calls"}

TRANSCRIPT:
"""
${transcript.slice(0, 60000)}
"""`;
}

async function analyze(agent: string, direction: string, transcript: string): Promise<{ result: any; model: string }> {
  let lastErr = "";
  for (const model of ANALYSIS_MODELS) {
    const isNew = USE_OPENAI && /^gpt-5|^o\d/.test(model);
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: coachPrompt(agent, direction, transcript) }],
      response_format: { type: "json_object" },
    };
    if (isNew) body.max_completion_tokens = 6000; else { body.max_tokens = 3000; body.temperature = 0.2; }
    const r = await fetch(`${AI_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AI_KEY()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

// ---------- queue ----------
async function processQueue(token: string, started: number) {
  // release calls stuck in processing (function timed out mid-call)
  await sb.from("calls").update({ status: "queued" })
    .eq("status", "processing").lt("processing_at", new Date(Date.now() - 15 * 60_000).toISOString()).lt("attempts", 3);
  await sb.from("calls").update({ status: "error", error: "Gave up after 3 attempts" })
    .eq("status", "processing").lt("processing_at", new Date(Date.now() - 15 * 60_000).toISOString()).gte("attempts", 3);

  const { data: queue } = await sb.from("calls").select("id, recording_uri, agent_name, direction, attempts, carrier_name")
    .eq("status", "queued").order("started_at", { ascending: false }).limit(BATCH);
  const done: string[] = [], failed: string[] = [];
  for (const c of queue ?? []) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const { data: claimed } = await sb.from("calls")
      .update({ status: "processing", processing_at: new Date().toISOString(), attempts: c.attempts + 1, error: null })
      .eq("id", c.id).eq("status", "queued").select("id");
    if (!claimed?.length) continue;
    try {
      const { blob, name } = await downloadRecording(c.recording_uri, token);
      const tx = await transcribe(blob, name);
      if (tx.text.trim().length < 40) {
        await sb.from("calls").update({ status: "skipped", transcript: tx.text, error: "Almost no speech in the recording" }).eq("id", c.id);
        continue;
      }
      const an = await analyze(c.agent_name ?? "the agent", c.direction ?? "Outbound", tx.text);
      const r = an.result;
      await sb.from("calls").update({
        status: "done", transcript: tx.text, result: { ...r, _models: { transcribe: tx.model, analysis: an.model } },
        overall: Math.max(0, Math.min(100, Math.round(Number(r.overall) || 0))), outcome: String(r.outcome ?? ""),
        carrier_name: c.carrier_name || (r.carrierName ? String(r.carrierName).slice(0, 120) : null), error: null,
      }).eq("id", c.id);
      done.push(c.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb.from("calls").update({ status: c.attempts + 1 >= 3 ? "error" : "queued", error: msg.slice(0, 500) }).eq("id", c.id);
      failed.push(c.id);
      if (/401|429|quota|billing/i.test(msg)) { await setState("last_error", msg); break; }
    }
  }
  return { done: done.length, failed: failed.length };
}

Deno.serve(async (req) => {
  const started = Date.now();
  const { data: ok } = await sb.rpc("check_sync_secret", { s: req.headers.get("x-sync-secret") ?? "" });
  if (!ok) return json({ error: "unauthorized" }, 401);

  const missing = ["RC_CLIENT_ID", "RC_CLIENT_SECRET", "RC_JWT"].filter((k) => !env(k));
  if (!env("OPENAI_API_KEY") && !env("GROQ_API_KEY")) missing.push("GROQ_API_KEY (free) or OPENAI_API_KEY");
  if (missing.length) {
    const msg = `Waiting for setup: add these Edge Function secrets in Supabase — ${missing.join(", ")}`;
    await setState("last_error", msg);
    await setState("last_run", new Date().toISOString());
    return json({ ok: false, error: msg });
  }
  try {
    const token = await rcToken();
    const added = await syncCallLog(token);
    const q = await processQueue(token, started);
    await setState("last_run", new Date().toISOString());
    if (!q.failed) await setState("last_error", "");
    return json({ ok: true, newCalls: added, ...q });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setState("last_error", msg.slice(0, 500));
    await setState("last_run", new Date().toISOString());
    return json({ ok: false, error: msg }, 500);
  }
});
