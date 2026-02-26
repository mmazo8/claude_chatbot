import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./app.css";

const MODELS = [
  { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
  { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

// ── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.success) {
        onLogin(data.token);
      } else {
        setError("Invalid password");
      }
    } catch {
      setError("Connection error");
    }
    setLoading(false);
  };

  return (
    <div className="login-screen">
      <div className="login-box">
        <div className="login-logo">
          <span className="logo-bracket">[</span>
          <span className="logo-text">WORKBENCH</span>
          <span className="logo-bracket">]</span>
        </div>
        <p className="login-sub">Claude API Interface</p>
        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="password"
            placeholder="enter password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="login-input"
            autoFocus
          />
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? "authenticating..." : "enter"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Token Counter ─────────────────────────────────────────────────────────────
function TokenDisplay({ usage }) {
  if (!usage) return null;
  return (
    <div className="token-display">
      {usage.input_tokens != null && (
        <span className="token-chip input">
          ↑ {usage.input_tokens.toLocaleString()}
        </span>
      )}
      {usage.output_tokens != null && (
        <span className="token-chip output">
          ↓ {usage.output_tokens.toLocaleString()}
        </span>
      )}
      {usage.cache_read_input_tokens > 0 && (
        <span className="token-chip cache-read">
          ⚡ {usage.cache_read_input_tokens.toLocaleString()} cached
        </span>
      )}
      {usage.cache_creation_input_tokens > 0 && (
        <span className="token-chip cache-write">
          📝 {usage.cache_creation_input_tokens.toLocaleString()} written
        </span>
      )}
    </div>
  );
}

// ── Message Bubble ────────────────────────────────────────────────────────────
function Message({ msg }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`message message-${msg.role}`}>
      <div className="message-header">
        <span className="message-role">{msg.role === "user" ? "you" : "claude"}</span>
        {msg.role === "assistant" && (
          <button className="copy-btn" onClick={copy}>
            {copied ? "copied!" : "copy"}
          </button>
        )}
      </div>
      <div className="message-content">
        {msg.role === "assistant" ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        ) : (
          <p style={{ whiteSpace: "pre-wrap" }}>{msg.content}</p>
        )}
      </div>
      {msg.usage && <TokenDisplay usage={msg.usage} />}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("auth_token") || "");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [system, setSystem] = useState("");
  const [model, setModel] = useState(MODELS[1].id);
  const [temperature, setTemperature] = useState(1);
  const [maxTokens, setMaxTokens] = useState(8192);
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [systemOpen, setSystemOpen] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleLogin = (t) => {
    sessionStorage.setItem("auth_token", t);
    setToken(t);
  };

  const handleLogout = () => {
    sessionStorage.removeItem("auth_token");
    setToken("");
  };

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return;

    const userMsg = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setStreaming(true);

    // Placeholder for streaming assistant message
    setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-auth-token": token,
        },
        body: JSON.stringify({
          messages: newMessages,
          system,
          model,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error("Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let usageData = {};

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6));

            if (parsed.type === "text") {
              fullText += parsed.text;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: fullText,
                  streaming: true,
                };
                return updated;
              });
            }

            if (parsed.type === "usage_start") {
              usageData = { ...usageData, ...parsed.usage };
            }

            if (parsed.type === "usage") {
              usageData = { ...usageData, ...parsed.usage };
            }

            if (parsed.type === "done") {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: fullText,
                  streaming: false,
                  usage: usageData,
                };
                return updated;
              });
            }

            if (parsed.type === "error") {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: `⚠️ Error: ${parsed.error}`,
                  streaming: false,
                };
                return updated;
              });
            }
          } catch {
            // skip
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: `⚠️ Error: ${err.message}`,
            streaming: false,
          };
          return updated;
        });
      }
    }

    setStreaming(false);
  }, [input, messages, streaming, token, system, model, temperature, maxTokens]);

  const stopStreaming = () => {
    abortRef.current?.abort();
    setStreaming(false);
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.streaming) {
        updated[updated.length - 1] = { ...last, streaming: false };
      }
      return updated;
    });
  };

  const clearConversation = () => {
    if (streaming) stopStreaming();
    setMessages([]);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!token) return <LoginScreen onLogin={handleLogin} />;

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="header">
        <div className="header-left">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)}>
            {sidebarOpen ? "◀" : "▶"}
          </button>
          <span className="header-title">
            <span className="logo-bracket">[</span>WORKBENCH<span className="logo-bracket">]</span>
          </span>
        </div>
        <div className="header-right">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="model-select"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <button className="theme-btn" onClick={toggleTheme} title="toggle theme">
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button className="clear-btn" onClick={clearConversation}>clear</button>
          <button className="logout-btn" onClick={handleLogout}>logout</button>
        </div>
      </header>

      <div className="main-layout">
        {/* ── Sidebar ── */}
        {sidebarOpen && (
          <aside className="sidebar">
            {/* System Prompt */}
            <div className="sidebar-section">
              <button
                className="section-toggle"
                onClick={() => setSystemOpen((v) => !v)}
              >
                system prompt {systemOpen ? "▾" : "▸"}
              </button>
              {systemOpen && (
                <textarea
                  className="system-textarea"
                  placeholder="You are a helpful assistant..."
                  value={system}
                  onChange={(e) => setSystem(e.target.value)}
                  rows={8}
                />
              )}
            </div>

            {/* Parameters */}
            <div className="sidebar-section">
              <p className="section-label">parameters</p>

              <div className="param-row">
                <label>temperature <span className="param-value">{temperature}</span></label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="slider"
                />
              </div>

              <div className="param-row">
                <label>max tokens <span className="param-value">{maxTokens.toLocaleString()}</span></label>
                <input
                  type="range"
                  min="256"
                  max="32000"
                  step="256"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(parseInt(e.target.value))}
                  className="slider"
                />
              </div>
            </div>

            {/* Beta Badges */}
            <div className="sidebar-section">
              <p className="section-label">active features</p>
              <div className="badge-list">
                <span className="badge">context-1m</span>
                <span className="badge">compact</span>
                <span className="badge">cache_control</span>
              </div>
            </div>
          </aside>
        )}

        {/* ── Chat Area ── */}
        <main className="chat-area">
          <div className="messages">
            {messages.length === 0 && (
              <div className="empty-state">
                <p>start a conversation</p>
                <p className="empty-hint">⌘↵ or Ctrl↵ to send</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <Message key={i} msg={msg} />
            ))}
            {streaming && messages[messages.length - 1]?.streaming && (
              <div className="streaming-indicator">
                <span />
                <span />
                <span />
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* ── Input Bar ── */}
          <div className="input-area">
            <textarea
              ref={textareaRef}
              className="chat-input"
              placeholder="send a message..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              disabled={streaming}
            />
            <div className="input-actions">
              <span className="input-hint">⌘↵ to send</span>
              {streaming ? (
                <button className="stop-btn" onClick={stopStreaming}>
                  ◼ stop
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={sendMessage}
                  disabled={!input.trim()}
                >
                  send ↵
                </button>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}