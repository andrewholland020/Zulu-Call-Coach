// team-admin: lets a signed-in manager create a login for a team member or set a new password.
// Passwords are typed by the manager in the dashboard and go straight to Supabase Auth.
import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function findUser(email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const u = data.users.find((x) => (x.email ?? "").toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 200) return null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(token);
  const me = u?.user?.email?.toLowerCase();
  if (!me) return json({ error: "Please sign in again." }, 401);
  const { data: m } = await admin.from("team_members").select("role").ilike("email", me).maybeSingle();
  if (m?.role !== "manager") return json({ error: "Only managers can do this." }, 403);

  let body: { action?: string; email?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email." }, 400);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

  try {
    const existing = await findUser(email);
    if (body.action === "create_login") {
      if (existing) {
        const { error } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
        if (error) throw new Error(error.message);
        return json({ ok: true, message: "This person already had a login; their password was updated." });
      }
      const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw new Error(error.message);
      return json({ ok: true, message: "Login created." });
    }
    if (body.action === "set_password") {
      if (!existing) return json({ error: "No login exists for this email yet." }, 404);
      const { error } = await admin.auth.admin.updateUserById(existing.id, { password });
      if (error) throw new Error(error.message);
      return json({ ok: true, message: "Password updated." });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
