// live-assist: during a call the dashboard sends ~10-second audio pieces from the agent's microphone
// and from the laptop's sound (the carrier). Gemini writes down what each side said and suggests
// what the agent should say next. Nothing is stored here; the dashboard keeps the running transcript.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const MODELS = env("LIVE_MODEL", "gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-flash-latest,gemini-2.5-flash").split(",").map((s) => s.trim());
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// cache who is allowed, so each 10-second piece does not re-check the database
const okUsers = new Map<string, number>();
const noThink = new Set<string>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!env("GEMINI_API_KEY")) return json({ error: "GEMINI_API_KEY is not set in Supabase secrets." }, 503);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(token);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return json({ error: "Please sign in again." }, 401);
  if (!((okUsers.get(email) ?? 0) > Date.now())) {
    const { data: m } = await admin.from("team_members").select("role").ilike("email", email).maybeSingle();
    if (!m) return json({ error: "No access." }, 403);
    okUsers.set(email, Date.now() + 10 * 60_000);
  }

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "Could not read the audio." }, 400); }
  const agentAudio = form.get("agent");
  const carrierAudio = form.get("carrier");
  const context = String(form.get("context") ?? "").slice(-3000);
  const done = String(form.get("done") ?? "");
  const about = String(form.get("about") ?? "").slice(0, 200);

  const parts: unknown[] = [];
  const add = async (label: string, f: FormDataEntryValue | null) => {
    if (f instanceof File && f.size > 800) {
      parts.push({ text: label });
      parts.push({ inline_data: { mime_type: (f.type || "audio/webm").split(";")[0], data: encodeBase64(new Uint8Array(await f.arrayBuffer())) } });
      return true;
    }
    return false;
  };
  const hasA = await add("AUDIO 1 — the sales AGENT's microphone (last ~10 seconds):", agentAudio);
  const hasC = await add("AUDIO 2 — the CARRIER / truck driver on the phone (last ~10 seconds):", carrierAudio);
  if (!hasA && !hasC) return json({ agent: "", carrier: "", tip: "", stage: "", objection: "" });

  parts.unshift({ text: `You are a live sales coach whispering to a sales agent of a US truck dispatch company during a phone call with a truck driver / owner-operator. The agent wants the driver to sign up for dispatch service (we find loads, negotiate rates, handle paperwork, fee is a % of each load).
Call process: 1 Opener (name, permission) 2 Reason for call 3 Discovery (trailer type, lanes, how they find loads now, rate per mile, empty days) 4 Value pitch in $ per mile/week 5 Objection handling (agree, then ask a question, give proof) 6 Close (one-load trial / callback time) 7 Lock-in (MC number, W-9, insurance, void check) 8 Tone.
${about ? `Known about this driver: ${about}\n` : ""}Steps already done: ${done || "none yet"}
Conversation so far:
"""
${context || "(call just started)"}
"""
Listen to the two new audio pieces below. Write exactly what each person said in them (English; empty string if silent or only noise). Then decide what the agent should say NEXT, given the whole conversation.
Return ONLY JSON: {"agent":"words the agent said in audio 1","carrier":"words the driver said in audio 2","tip":"ONE short line (max 20 words) the agent can say right now, in natural spoken English; empty if nothing useful to add","stage":"the process step number (1-8) the call is now at, or empty","objection":"short name of the driver's objection if he raised one in audio 2, else empty"}` });

  let lastErr = "";
  const list = [...MODELS];
  for (const model of list) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 1024, ...(noThink.has(model) ? {} : { thinkingConfig: /2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "low" } }) } }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      const text = (d.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      try {
        const o = JSON.parse(text.replace(/^```(json)?|```$/g, "").trim());
        return json({
          agent: String(o.agent ?? "").slice(0, 1500), carrier: String(o.carrier ?? "").slice(0, 1500),
          tip: String(o.tip ?? "").slice(0, 300), stage: String(o.stage ?? "").slice(0, 3), objection: String(o.objection ?? "").slice(0, 80), model,
        });
      } catch { lastErr = `${model}: bad JSON`; }
    } else {
      lastErr = `${model}: ${r.status} ${d.error?.message ?? ""}`;
      if (r.status === 400 && /think/i.test(d.error?.message ?? "") && !noThink.has(model)) { noThink.add(model); list.splice(list.indexOf(model) + 1, 0, model); continue; }
      if (r.status === 400 && /API key/i.test(d.error?.message ?? "")) break;
    }
  }
  return json({ error: /429/.test(lastErr) ? "The free AI limit is reached for the moment." : `AI error — ${lastErr}` }, 502);
});
