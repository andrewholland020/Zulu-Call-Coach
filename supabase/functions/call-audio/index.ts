// call-audio: streams a call's recording to a signed-in team member who is allowed to see the call.
// Uploaded recordings come from the private "recordings" bucket; RingCentral calls are fetched
// from RingCentral on demand (nothing extra is stored).
import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const RC_SERVER = env("RC_SERVER", "https://platform.ringcentral.com");
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const err = (msg: string, status: number) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let rcCache: { token: string; exp: number } | null = null;
async function rcToken(): Promise<string> {
  if (rcCache && rcCache.exp > Date.now()) return rcCache.token;
  const basic = btoa(`${env("RC_CLIENT_ID")}:${env("RC_CLIENT_SECRET")}`);
  const r = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: env("RC_JWT") }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error("RingCentral login failed");
  rcCache = { token: t.access_token, exp: Date.now() + Math.max(60, (t.expires_in ?? 3600) - 120) * 1000 };
  return t.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return err("Missing call id", 400);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(token);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return err("Please sign in again.", 401);
  const { data: m } = await admin.from("team_members").select("*").ilike("email", email).maybeSingle();
  if (!m) return err("No access.", 403);

  const { data: c } = await admin.from("calls").select("agent_name, audio_path, recording_uri").eq("id", id).maybeSingle();
  if (!c) return err("Call not found.", 404);
  if (m.role !== "manager" && (c.agent_name ?? "").toLowerCase() !== (m.agent_name ?? "").toLowerCase()) return err("No access.", 403);

  try {
    if (c.audio_path) {
      const { data, error } = await admin.storage.from("recordings").download(c.audio_path);
      if (error || !data) return err("Recording file not found.", 404);
      return new Response(data, { headers: { ...CORS, "Content-Type": data.type || "audio/mpeg", "Cache-Control": "private, max-age=600" } });
    }
    if (c.recording_uri) {
      if (!env("RC_JWT")) return err("RingCentral is not connected yet.", 503);
      const r = await fetch(c.recording_uri, { headers: { Authorization: `Bearer ${await rcToken()}` } });
      if (!r.ok || !r.body) return err(`RingCentral could not return the recording (${r.status}).`, 502);
      return new Response(r.body, { headers: { ...CORS, "Content-Type": r.headers.get("content-type") ?? "audio/mpeg", "Cache-Control": "private, max-age=600" } });
    }
    return err("This call has no recording (it was added as a pasted transcript).", 404);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
});
