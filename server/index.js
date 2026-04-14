import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import pg from "pg";
import multer from "multer";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const CLIENT_DIST = path.resolve(__dirname, "../client/dist");

// ── File upload setup ────────────────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(__dirname, "../uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = crypto.randomUUID();
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// ── Database setup ────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
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

    CREATE TABLE IF NOT EXISTS files (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      username        TEXT NOT NULL,
      original_name   TEXT NOT NULL,
      stored_name     TEXT NOT NULL,
      mime_type       TEXT NOT NULL,
      size_bytes      BIGINT NOT NULL,
      created_at      BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_files_conversation_id ON files(conversation_id);
  `);

  console.log("Database initialized");
}

console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("PORT:", PORT);
console.log("CLIENT_DIST:", CLIENT_DIST);

app.use(express.json({ limit: "100mb" }));
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production" ? false : "http://localhost:5173",
  })
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const cleaned = content
    .map((block) => {
      if (!block || typeof block !== "object") return null;

      if (block.type === "text") {
        return isNonEmptyString(block.text)
          ? { type: "text", text: block.text }
          : null;
      }

      if (block.type === "compaction") {
        return isNonEmptyString(block.content)
          ? { type: "compaction", content: block.content }
          : null;
      }

      // Pass through image and document blocks (for file attachments)
      if (block.type === "image" && block.source) {
        return block;
      }

      if (block.type === "document" && block.source) {
        return block;
      }

      return null;
    })
    .filter(Boolean);

  if (cleaned.length === 1 && cleaned[0].type === "text") {
    return cleaned[0].text;
  }

  return cleaned;
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

// ── Serve React frontend ──────────────────────────────────────────────────────
app.use(express.static(CLIENT_DIST));

// ── Auth middleware (API routes only) ─────────────────────────────────────────
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  if (req.path === "/api/auth") return next();
  // File downloads use token query param for browser-direct access
  if (req.path.startsWith("/api/files/") && req.method === "GET" && req.query.token) {
    if (req.query.token !== process.env.APP_PASSWORD) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  }

  const token = req.headers["x-auth-token"];
  if (!token || token !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// ── Auth endpoint ─────────────────────────────────────────────────────────────
app.post("/api/auth", (req, res) => {
  const { password, username } = req.body;

  if (!username?.trim()) {
    return res
      .status(400)
      .json({ success: false, error: "Username required" });
  }

  if (password === process.env.APP_PASSWORD) {
    res.json({
      success: true,
      token: process.env.APP_PASSWORD,
      username: username.trim().toLowerCase(),
    });
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

    if (convo.rows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    const messages = await pool.query(
      `SELECT id, role, content, usage, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC, id ASC`,
      [req.params.id]
    );

    const parsed = messages.rows.map((m) => {
      let content = m.content;

      try {
        const parsedJson = JSON.parse(content);
        // Preserve {text, files} wrapper for file-bearing user messages
        if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson) && parsedJson.files) {
          content = JSON.stringify(parsedJson);
        } else {
          content = sanitizeContent(parsedJson);
        }
      } catch {
        content = sanitizeContent(content);
      }

      return {
        id: m.id,
        role: m.role,
        content,
        usage: m.usage,
        created_at: m.created_at,
      };
    });

    res.json({ ...convo.rows[0], messages: parsed });
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
    await pool.query(
      "DELETE FROM conversations WHERE id = $1 AND username = $2",
      [req.params.id, username]
    );
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

  const { role, content, usage, created_at } = req.body;
  const now = created_at || Date.now();

  const cleanedContent = sanitizeContent(content);
  const contentStr =
    typeof cleanedContent === "string"
      ? cleanedContent
      : JSON.stringify(cleanedContent);

  try {
    await pool.query(
      "INSERT INTO messages (conversation_id, username, role, content, usage, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [req.params.id, username, role, contentStr, usage ? JSON.stringify(usage) : null, now]
    );

    await pool.query(
      "UPDATE conversations SET updated_at = $1 WHERE id = $2",
      [now, req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE a message from a conversation
// If deleting a user message, also delete the assistant message immediately after it.
app.delete("/api/conversations/:id/messages/:messageId", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });

  const { id: conversationId, messageId } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const convoResult = await client.query(
      "SELECT id FROM conversations WHERE id = $1 AND username = $2",
      [conversationId, username]
    );

    if (convoResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Conversation not found" });
    }

    const targetResult = await client.query(
      `SELECT id, role, created_at
       FROM messages
       WHERE id = $1 AND conversation_id = $2 AND username = $3`,
      [messageId, conversationId, username]
    );

    if (targetResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Message not found" });
    }

    const target = targetResult.rows[0];
    const idsToDelete = [target.id];

    if (target.role === "user") {
      const nextAssistantResult = await client.query(
        `SELECT id
         FROM messages
         WHERE conversation_id = $1
           AND username = $2
           AND role = 'assistant'
           AND (
             created_at > $3
             OR (created_at = $3 AND id > $4)
           )
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        [conversationId, username, target.created_at, target.id]
      );

      if (nextAssistantResult.rows.length > 0) {
        idsToDelete.push(nextAssistantResult.rows[0].id);
      }
    }

    await client.query(
      `DELETE FROM messages
       WHERE conversation_id = $1
         AND username = $2
         AND id = ANY($3::int[])`,
      [conversationId, username, idsToDelete]
    );

    const latestRemaining = await client.query(
      `SELECT created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [conversationId]
    );

    await client.query(
      "UPDATE conversations SET updated_at = $1 WHERE id = $2",
      [latestRemaining.rows[0]?.created_at || Date.now(), conversationId]
    );

    await client.query("COMMIT");

    res.json({ success: true, deleted_ids: idsToDelete });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Database error" });
  } finally {
    client.release();
  }
});

// ── File upload ──────────────────────────────────────────────────────────────
app.post("/api/conversations/:id/files", upload.array("files", 10), async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });

  const conversationId = req.params.id;

  try {
    // Verify conversation belongs to user
    const convo = await pool.query(
      "SELECT id FROM conversations WHERE id = $1 AND username = $2",
      [conversationId, username]
    );
    if (convo.rows.length === 0) {
      // Clean up uploaded files
      for (const f of req.files) fs.unlinkSync(f.path);
      return res.status(404).json({ error: "Conversation not found" });
    }

    const results = [];
    for (const f of req.files) {
      const fileId = crypto.randomUUID();
      const now = Date.now();
      await pool.query(
        "INSERT INTO files (id, conversation_id, username, original_name, stored_name, mime_type, size_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [fileId, conversationId, username, f.originalname, f.filename, f.mimetype, f.size, now]
      );
      results.push({
        id: fileId,
        original_name: f.originalname,
        mime_type: f.mimetype,
        size_bytes: f.size,
        created_at: now,
      });
    }

    res.json({ success: true, files: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// GET list files for a conversation
app.get("/api/conversations/:id/files", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });

  try {
    const result = await pool.query(
      "SELECT id, original_name, mime_type, size_bytes, created_at FROM files WHERE conversation_id = $1 AND username = $2 ORDER BY created_at ASC",
      [req.params.id, username]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET all files for a user (grouped by conversation)
app.get("/api/files", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });

  try {
    const result = await pool.query(
      `SELECT f.id, f.original_name, f.mime_type, f.size_bytes, f.created_at, f.conversation_id, c.title as conversation_title
       FROM files f
       JOIN conversations c ON f.conversation_id = c.id
       WHERE f.username = $1
       ORDER BY f.created_at DESC`,
      [username]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET download a specific file
app.get("/api/files/:fileId", async (req, res) => {
  const username = req.headers["x-username"] || req.query.username;
  if (!username) return res.status(400).json({ error: "Username required" });

  try {
    const result = await pool.query(
      "SELECT * FROM files WHERE id = $1 AND username = $2",
      [req.params.fileId, username]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });

    const file = result.rows[0];
    const filePath = path.join(UPLOAD_DIR, file.stored_name);

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing from disk" });

    res.setHeader("Content-Disposition", `attachment; filename="${file.original_name}"`);
    res.setHeader("Content-Type", file.mime_type);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Download failed" });
  }
});

// POST get base64 content for files (used when sending to Claude)
app.post("/api/files/content", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.status(400).json({ error: "Username required" });

  const { fileIds } = req.body;
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: "fileIds required" });
  }

  try {
    const result = await pool.query(
      "SELECT id, stored_name, original_name, mime_type FROM files WHERE id = ANY($1::text[]) AND username = $2",
      [fileIds, username]
    );

    const contents = [];
    for (const file of result.rows) {
      const filePath = path.join(UPLOAD_DIR, file.stored_name);
      if (!fs.existsSync(filePath)) continue;

      const data = fs.readFileSync(filePath);
      const base64 = data.toString("base64");

      // Determine Anthropic content block type
      const isImage = /^image\/(jpeg|png|gif|webp)$/i.test(file.mime_type);
      const isPdf = file.mime_type === "application/pdf";

      if (isImage) {
        contents.push({
          id: file.id,
          original_name: file.original_name,
          block: {
            type: "image",
            source: { type: "base64", media_type: file.mime_type, data: base64 },
          },
        });
      } else if (isPdf) {
        contents.push({
          id: file.id,
          original_name: file.original_name,
          block: {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          },
        });
      } else {
        // For text-based files, read as text and include as a text block
        let textContent;
        try {
          textContent = data.toString("utf-8");
        } catch {
          textContent = `[Binary file: ${file.original_name}]`;
        }
        contents.push({
          id: file.id,
          original_name: file.original_name,
          block: {
            type: "text",
            text: `<file name="${file.original_name}">\n${textContent}\n</file>`,
          },
        });
      }
    }

    res.json({ contents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to read files" });
  }
});

function buildAnthropicRequestBody({
  messages,
  system,
  model,
  temperature,
  max_tokens,
}) {
  const cleanMessages = (messages || [])
    .map((msg, i, arr) => {
      const cleanedContent = sanitizeContent(msg.content);
      const isLastUser = msg.role === "user" && i === arr.length - 1;

      if (
        cleanedContent === "" ||
        (Array.isArray(cleanedContent) && cleanedContent.length === 0)
      ) {
        return null;
      }

      if (Array.isArray(cleanedContent)) {
        if (msg.role === "assistant") {
          const blocks = cleanedContent.map((block) => {
            if (block.type === "compaction") {
              return { ...block, cache_control: { type: "ephemeral" } };
            }
            return block;
          });

          return { role: msg.role, content: blocks };
        }

        // Check if there are non-text blocks (image, document)
        const hasFileBlocks = cleanedContent.some(
          (b) => b.type === "image" || b.type === "document"
        );

        if (hasFileBlocks) {
          // Keep all blocks as-is, add cache_control to last text block if last user
          const blocks = cleanedContent.map((block) => ({ ...block }));
          if (isLastUser && blocks.length > 0) {
            // Add cache_control to the last text block
            for (let j = blocks.length - 1; j >= 0; j--) {
              if (blocks[j].type === "text") {
                blocks[j].cache_control = { type: "ephemeral" };
                break;
              }
            }
          }
          return { role: msg.role, content: blocks };
        }

        const text = cleanedContent
          .filter((b) => b.type === "text")
          .map((b) => b.text || "")
          .join("");

        if (!text.trim()) return null;

        if (isLastUser) {
          return {
            role: "user",
            content: [
              {
                type: "text",
                text,
                cache_control: { type: "ephemeral" },
              },
            ],
          };
        }

        return { role: msg.role, content: text };
      }

      const text = typeof cleanedContent === "string" ? cleanedContent : "";
      if (!text.trim()) return null;

      if (isLastUser) {
        return {
          role: "user",
          content: [
            {
              type: "text",
              text,
              cache_control: { type: "ephemeral" },
            },
          ],
        };
      }

      return { role: msg.role, content: text };
    })
    .filter(Boolean);

  const requestBody = {
    model,
    messages: cleanMessages,
  };

  if (typeof temperature === "number") requestBody.temperature = temperature;
  if (typeof max_tokens === "number") requestBody.max_tokens = max_tokens;

  if (system && system.trim()) {
    requestBody.system = [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  requestBody.context_management = {
    edits: [
      {
        type: "compact_20260112",
        "trigger": {"type": "input_tokens", "value": 999999},
      },
    ],
  };

  return requestBody;
}

async function anthropicFetch(path, body) {
  console.log("🧠 Sending to Anthropic model:", body.model);
  console.log(
    "🧪 Beta header:",
    "context-1m-2025-08-07,compact-2026-01-12"
  );

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

// ── Token counting (prompt tracker) ───────────────────────────────────────────
app.post("/api/count-tokens", async (req, res) => {
  const { messages, system, model } = req.body;

  try {
    const body = buildAnthropicRequestBody({
      messages,
      system,
      model: model || "claude-opus-4-6",
    });

    const response = await anthropicFetch("/v1/messages/count_tokens", body);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "Token count failed",
      });
    }

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
      messages,
      system,
      model: model || "claude-opus-4-6",
      temperature: temperature ?? 1,
      max_tokens: max_tokens || 32000,
    });

    requestBody.stream = true;

    console.log("🧠 MODEL BEING SENT TO ANTHROPIC:", requestBody.model);

    const response = await anthropicFetch("/v1/messages", requestBody);

    if (!response.ok) {
      const error = await response.json();
      res.write(
        `data: ${JSON.stringify({
          type: "error",
          error: error.error?.message || "API error",
        })}\n\n`
      );
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let currentBlockType = null;
    let currentCompactionContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const line of decoder.decode(value).split("\n")) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.type === "content_block_start") {
            currentBlockType = parsed.content_block?.type || null;

            if (currentBlockType === "compaction") {
              currentCompactionContent = "";
              res.write(
                `data: ${JSON.stringify({ type: "compaction_start" })}\n\n`
              );
            }
          }

          if (
            parsed.type === "content_block_delta" &&
            parsed.delta?.type === "text_delta"
          ) {
            res.write(
              `data: ${JSON.stringify({
                type: "text",
                text: parsed.delta.text,
              })}\n\n`
            );
          }

          if (
            parsed.type === "content_block_delta" &&
            parsed.delta?.type === "compaction_delta"
          ) {
            currentCompactionContent += parsed.delta.content || "";
          }

          if (parsed.type === "content_block_stop") {
            if (
              currentBlockType === "compaction" &&
              currentCompactionContent.trim()
            ) {
              res.write(
                `data: ${JSON.stringify({
                  type: "compaction",
                  content: currentCompactionContent,
                })}\n\n`
              );
            }

            currentBlockType = null;
            currentCompactionContent = "";
          }

          if (parsed.type === "message_delta" && parsed.usage) {
            res.write(
              `data: ${JSON.stringify({
                type: "usage",
                usage: parsed.usage,
              })}\n\n`
            );
          }

          if (parsed.type === "message_start" && parsed.message?.usage) {
            res.write(
              `data: ${JSON.stringify({
                type: "usage_start",
                usage: parsed.message.usage,
              })}\n\n`
            );
          }

          if (parsed.type === "message_delta") {
            if (parsed.usage?.iterations) {
              res.write(
                `data: ${JSON.stringify({
                  type: "usage_iterations",
                  iterations: parsed.usage.iterations,
                })}\n\n`
              );
            }
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Error:", err);
    res.write(
      `data: ${JSON.stringify({
        type: "error",
        error: err.message,
      })}\n\n`
    );
    res.end();
  }
});

// ── Catch-all: serve React app ────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, "index.html"));
});

// ── Start server ──────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });