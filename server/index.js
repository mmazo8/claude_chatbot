import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const CLIENT_DIST = path.resolve(__dirname, "../client/dist");

// ── Database setup ────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      username    TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT 'New conversation',
      model       TEXT NOT NULL,
      system      TEXT NOT NULL DEFAULT '',
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              SERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      username        TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      usage           JSONB,
      created_at      BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_username ON conversations(username);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
  `);
  console.log("Database initialized");
}

console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("PORT:", PORT);
console.log("CLIENT_DIST:", CLIENT_DIST);

app.use(express.json({ limit: "10mb" }));
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

// ── Conversations CRUD ────────────────────────────────────────────────────────

// GET all conversations for a user
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

// GET a single conversation with its messages
app.get("/api/conversations/:id", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });
  try {
    const convo = await pool.query(
      "SELECT * FROM conversations WHERE id = $1 AND username = $2",
      [req.params.id, username]
    );
    if (convo.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const messages = await pool.query(
      "SELECT role, content, usage FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [req.params.id]
    );
    res.json({ ...convo.rows[0], messages: messages.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST create a new conversation
app.post("/api/conversations", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });
  const { id, title, model, system, created_at, updated_at } = req.body;
  try {
    await pool.query(
      "INSERT INTO conversations (id, username, title, model, system, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, username, title || "New conversation", model, system || "", created_at, updated_at]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// PATCH update conversation metadata (title, model, system)
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

// DELETE a conversation
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

// POST add a message to a conversation
app.post("/api/conversations/:id/messages", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });
  const { role, content, usage } = req.body;
  const now = Date.now();
  try {
    await pool.query(
      "INSERT INTO messages (conversation_id, username, role, content, usage, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [req.params.id, username, role, content, usage ? JSON.stringify(usage) : null, now]
    );
    // Update conversation updated_at
    await pool.query("UPDATE conversations SET updated_at = $1 WHERE id = $2", [now, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
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
    const cleanMessages = messages
      .filter((msg) => !msg.streaming && msg.content)
      .map((msg, i, arr) => {
        const isLastUser = msg.role === "user" && i === arr.length - 1;
        const text = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(b => b.text || "").join("")
            : "";
        if (isLastUser) {
          return { role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] };
        }
        return { role: msg.role, content: text };
      });

    const requestBody = {
      model: model || "claude-opus-4-5-20251101",
      max_tokens: max_tokens || 32000,
      temperature: temperature ?? 1,
      stream: true,
      messages: cleanMessages,
    };

    if (system && system.trim()) {
      requestBody.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "context-1m-2025-08-07,compact-2026-01-12",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.json();
      res.write(`data: ${JSON.stringify({ type: "error", error: error.error?.message || "API error" })}\n\n`);
      res.end();
      return;
    }

    const reader = response.body.getReader();
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
        } catch { /* skip */ }
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    res.end();
  }
});

// ── Catch-all: serve React app ────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"));
});

// ── Start server ──────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});