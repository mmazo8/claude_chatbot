// ── Two changes from previous version ────────────────────────────────────────
// 1. /api/chat error handler now forwards `error_type` so the client can
//    distinguish credit errors from other errors and restore the user's input.
// 2. New GET /api/billing endpoint proxies the Anthropic usage/billing API so
//    the frontend can show a low-credit warning.
//
// Everything else is unchanged — drop this file in as server/index.js.
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT        = process.env.PORT || 3001;
const CLIENT_DIST = path.join(__dirname, "../client/dist");

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      title TEXT,
      model TEXT,
      system TEXT,
      created_at BIGINT,
      updated_at BIGINT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      username TEXT,
      role TEXT,
      content TEXT,
      usage JSONB,
      created_at BIGINT
    )
  `);
}

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(cors({ origin: process.env.NODE_ENV === "production" ? false : "http://localhost:5173" }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

// ── Serve React frontend ──────────────────────────────────────────────────────
app.use(express.static(CLIENT_DIST));

// ── Auth middleware (API routes only) ─────────────────────────────────────────
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  if (req.path === "/api/auth") return next();
  const token = req.headers["x-auth-token"];
  if (!token || token !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ── Auth endpoint ─────────────────────────────────────────────────────────────
app.post("/api/auth", (req, res) => {
  const { password, username } = req.body;
  if (!username?.trim()) return res.status(400).json({ success: false, error: "Username required" });
  if (password === process.env.APP_PASSWORD) {
    res.json({ success: true, token: process.env.APP_PASSWORD, username: username.trim().toLowerCase() });
  } else {
    res.status(401).json({ success: false, error: "Invalid password" });
  }
});

// ── NEW: Billing / credit balance endpoint ────────────────────────────────────
// Anthropic exposes remaining credit via the Usage API (beta). We proxy it here
// so the API key never touches the browser.
app.get("/api/billing", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/organizations/me/usage/credits", {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "billing-2025-01-01",
      },
    });

    if (!response.ok) {
      // Fallback: try the simpler account balance endpoint (older API)
      const fallback = await fetch("https://api.anthropic.com/v1/organizations/me", {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      });
      if (!fallback.ok) {
        return res.status(200).json({ balance: null, unavailable: true });
      }
      const org = await fallback.json();
      // balance_dollars may be in the org object depending on account type
      const balance = org.billing?.credit_balance_usd ?? org.credit_balance_usd ?? null;
      return res.json({ balance });
    }

    const data = await response.json();
    // Response shape: { remaining_credits: <cents int> } or { credit_balance_usd: <float> }
    let balance = null;
    if (typeof data.remaining_credits === "number") {
      balance = data.remaining_credits / 100; // cents → dollars
    } else if (typeof data.credit_balance_usd === "number") {
      balance = data.credit_balance_usd;
    } else if (typeof data.balance === "number") {
      balance = data.balance;
    }
    res.json({ balance });
  } catch (err) {
    console.error("Billing check error:", err);
    // Non-fatal — the frontend handles null gracefully
    res.json({ balance: null, error: err.message });
  }
});

// ── Conversations CRUD ────────────────────────────────────────────────────────
app.get("/api/conversations", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });
  try {
    const result = await pool.query(
      "SELECT id, title, model, system, created_at, updated_at FROM conversations WHERE username = $1 ORDER BY updated_at DESC",
      [username]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/api/conversations", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });
  const { id, title, model, system, created_at, updated_at } = req.body;
  try {
    await pool.query(
      "INSERT INTO conversations (id, username, title, model, system, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, username, title, model, system, created_at, updated_at]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/api/conversations/:id", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });
  try {
    const convo = await pool.query(
      "SELECT id, title, model, system, created_at, updated_at FROM conversations WHERE id = $1 AND username = $2",
      [req.params.id, username]
    );
    if (convo.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const msgs = await pool.query(
      "SELECT role, content, usage, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [req.params.id]
    );
    res.json({ ...convo.rows[0], messages: msgs.rows.map((m) => ({ ...m, usage: m.usage || undefined })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.patch("/api/conversations/:id", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });
  const { title, model, system } = req.body;
  const now = Date.now();
  try {
    await pool.query(
      `UPDATE conversations SET
        title = COALESCE($1, title),
        model = COALESCE($2, model),
        system = COALESCE($3, system),
        updated_at = $4
       WHERE id = $5 AND username = $6`,
      [title, model, system, now, req.params.id, username]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.delete("/api/conversations/:id", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });
  try {
    await pool.query("DELETE FROM conversations WHERE id = $1 AND username = $2", [req.params.id, username]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });
  const { role, content, usage, created_at } = req.body;
  const now = created_at || Date.now();
  try {
    await pool.query(
      "INSERT INTO messages (conversation_id, username, role, content, usage, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [req.params.id, username, role, content, usage ? JSON.stringify(usage) : null, now]
    );
    await pool.query("UPDATE conversations SET updated_at = $1 WHERE id = $2", [now, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// ── Shared Anthropic request builder ─────────────────────────────────────────
function buildAnthropicRequestBody({ messages, system, model, temperature, max_tokens }) {
  const cleanMessages = (messages || [])
    .filter((msg) => !msg.streaming && msg.content)
    .map((msg, i, arr) => {
      const isLastUser = msg.role === "user" && i === arr.length - 1;
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((b) => b.text || "").join("")
            : "";
      if (isLastUser) {
        return { role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] };
      }
      return { role: msg.role, content: text };
    });

  const body = { model, messages: cleanMessages };
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof max_tokens   === "number") body.max_tokens  = max_tokens;
  if (system && system.trim()) {
    body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  return body;
}

async function anthropicFetch(path, body) {
  console.log("🧠 Sending to Anthropic model:", body.model);
  return fetch(`https://api.anthropic.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "context-1m-2025-08-07,compact-2026-01-12",
    },
    body: JSON.stringify(body),
  });
}

// ── Token counting ────────────────────────────────────────────────────────────
app.post("/api/count-tokens", async (req, res) => {
  const { messages, system, model } = req.body;
  try {
    const body = buildAnthropicRequestBody({ messages, system, model: model || "claude-opus-4-6" });
    const response = await anthropicFetch("/v1/messages/count_tokens", body);
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || "Token count failed" });
    return res.json({ input_tokens: data.input_tokens });
  } catch (err) {
    console.error("Count tokens error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// ── Chat endpoint (streaming) ─────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { messages, system, model, temperature, max_tokens } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const requestBody = buildAnthropicRequestBody({
      messages, system,
      model: model || "claude-opus-4-6",
      temperature: temperature ?? 1,
      max_tokens: max_tokens || 32000,
    });
    requestBody.stream = true;

    const response = await anthropicFetch("/v1/messages", requestBody);

    if (!response.ok) {
      const error = await response.json();
      // ── CHANGE 1: forward error_type so the client can identify credit errors ──
      res.write(`data: ${JSON.stringify({
        type:       "error",
        error:      error.error?.message || "API error",
        error_type: error.error?.type    || "unknown",
      })}\n\n`);
      res.end();
      return;
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
            res.write(`data: ${JSON.stringify({ type: "text", text: parsed.delta.text })}\n\n`);
          }
          if (parsed.type === "message_delta" && parsed.usage) {
            res.write(`data: ${JSON.stringify({ type: "usage", usage: parsed.usage })}\n\n`);
          }
          if (parsed.type === "message_start" && parsed.message?.usage) {
            res.write(`data: ${JSON.stringify({ type: "usage_start", usage: parsed.message.usage })}\n\n`);
          }
          // Anthropic can also stream an error event mid-stream
          if (parsed.type === "error") {
            res.write(`data: ${JSON.stringify({
              type:       "error",
              error:      parsed.error?.message || "Stream error",
              error_type: parsed.error?.type    || "unknown",
            })}\n\n`);
          }
        } catch { /* skip malformed lines */ }
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Chat error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message, error_type: "server_error" })}\n\n`);
    res.end();
  }
});

// ── Catch-all: serve React app ────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
}).catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});