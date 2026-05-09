"use client";

import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { tierNarrative, type ScoreBreakdown } from "@/lib/scoring";
import {
  BACKGROUND_COLLECTION_MIN_TURNS,
  OPENING_ASSISTANT_MESSAGE,
  type ExpertIndustry,
} from "@/lib/prompts";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type AnalyzeResponse = {
  distillation: {
    summary: string;
    uniqueSignals: string[];
    riskSignals: string[];
    actionPlan: string[];
  };
  score: ScoreBreakdown;
};

type ChatHistorySnapshot = {
  messages: ChatMessage[];
  chatIndustry: ExpertIndustry;
  fastTrack: boolean;
  toolContext: string;
  importedSources: ImportedSource[];
};

type SessionSnapshot = ChatHistorySnapshot & {
  id: string;
  title: string;
  createdAt: number;
};

type ImportedSource = {
  id: string;
  title: string;
  sourceType: "url" | "document";
  chars: number;
};

type IngestResponse = {
  sourceType: "url" | "document";
  title: string;
  content: string;
  chars: number;
  error?: string;
};

type ReplyStreamEvent =
  | { type: "delta"; content: string }
  | { type: "done"; stage?: string }
  | { type: "error"; error?: string };

const SESSIONS_STORAGE_KEY = "expert-value-mvp.sessions.v2";

const INDUSTRIES: ExpertIndustry[] = [
  "科技互联网",
  "金融与投资",
  "制造与供应链",
  "教育与培训",
  "医疗与健康",
  "消费与零售",
  "其他",
];

const OPENING_MESSAGE: ChatMessage = {
  role: "assistant",
  content: OPENING_ASSISTANT_MESSAGE,
};

const markdownComponents = {
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="mb-1 last:mb-0" {...props} />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="my-1 list-disc pl-5 marker:text-slate-500" {...props} />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className="my-1 list-decimal pl-5 marker:text-slate-500" {...props} />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement>) => (
    <li className="my-0.5" {...props} />
  ),
  blockquote: (props: React.HTMLAttributes<HTMLElement>) => (
    <blockquote
      className="my-2 border-l-4 border-slate-300 bg-slate-50 py-1 pl-3 text-slate-600"
      {...props}
    />
  ),
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg bg-slate-800 px-3 py-2 text-slate-100"
      {...props}
    />
  ),
  code: ({
    inline,
    className,
    children,
    ...props
  }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
  } & React.HTMLAttributes<HTMLElement>) => {
    if (inline) {
      return (
        <code
          className="rounded bg-slate-200 px-1 py-0.5 font-mono text-[12px] text-slate-700"
          {...props}
        >
          {children}
        </code>
      );
    }

    return (
      <code className={`${className ?? ""} font-mono text-[12px] leading-6`} {...props}>
        {children}
      </code>
    );
  },
};

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([OPENING_MESSAGE]);
  const [input, setInput] = useState("");
  const [chatIndustry, setChatIndustry] = useState<ExpertIndustry>("其他");
  const [fastTrack, setFastTrack] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const [toolContext, setToolContext] = useState("");
  const [importedSources, setImportedSources] = useState<ImportedSource[]>([]);
  const [ingestingLabel, setIngestingLabel] = useState("");
  const [allSessions, setAllSessions] = useState<SessionSnapshot[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [showSessions, setShowSessions] = useState(false);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");
  const [result, setResult] = useState<AnalyzeResponse | null>(null);

  const [leadName, setLeadName] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadWechat, setLeadWechat] = useState("");
  const [leadIndustry, setLeadIndustry] = useState(INDUSTRIES[0]);
  const [leadConsent, setLeadConsent] = useState(false);
  const [leadLoading, setLeadLoading] = useState(false);
  const [leadMessage, setLeadMessage] = useState("");

  const userTurnCount = useMemo(
    () => messages.filter((m) => m.role === "user").length,
    [messages]
  );

  const narrative = useMemo(() => {
    if (!result) return null;
    return tierNarrative(result.score.tier);
  }, [result]);

  // ── helpers ──────────────────────────────────────────────────
  const makeSessionId = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const getSessionTitle = (msgs: ChatMessage[]) => {
    const first = msgs.find((m) => m.role === "user");
    if (!first) return "新对话";
    const text = first.content.replace(/【tool[^】]*】[^\n]*/g, "").trim();
    return text.slice(0, 28) + (text.length > 28 ? "…" : "");
  };

  const loadSessionsFromStorage = (): SessionSnapshot[] => {
    try {
      const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown[];
      return (parsed as SessionSnapshot[]).filter(
        (s) => s && typeof s.id === "string" && Array.isArray(s.messages)
      );
    } catch { return []; }
  };

  const saveSessionsToStorage = (sessions: SessionSnapshot[]) => {
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  };

  // ── load on mount ─────────────────────────────────────────────
  useEffect(() => {
    try {
      // Migrate from old v1 single-session key
      const oldRaw = window.localStorage.getItem("expert-value-mvp.chat-history.v1");
      let migrated: SessionSnapshot | null = null;
      if (oldRaw) {
        try {
          const p = JSON.parse(oldRaw) as ChatHistorySnapshot;
          if (Array.isArray(p.messages) && p.messages.length > 1) {
            migrated = {
              id: "migrated-" + Date.now().toString(36),
              title: getSessionTitle(p.messages),
              createdAt: Date.now() - 1,
              ...p,
            };
          }
        } catch { /* ignore */ }
        window.localStorage.removeItem("expert-value-mvp.chat-history.v1");
      }

      let sessions = loadSessionsFromStorage();
      if (migrated) {
        sessions = [migrated, ...sessions.filter((s) => s.id !== migrated!.id)];
        saveSessionsToStorage(sessions);
      }
      setAllSessions(sessions);

      const latest = sessions[0];
      if (latest) {
        const id = latest.id;
        setActiveSessionId(id);
        setMessages(latest.messages.filter(
          (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
        ));
        if (INDUSTRIES.includes(latest.chatIndustry)) setChatIndustry(latest.chatIndustry);
        if (typeof latest.fastTrack === "boolean") setFastTrack(latest.fastTrack);
        if (typeof latest.toolContext === "string") setToolContext(latest.toolContext);
        if (Array.isArray(latest.importedSources)) setImportedSources(latest.importedSources);
      } else {
        const id = makeSessionId();
        setActiveSessionId(id);
      }
    } catch { /* ignore */ }
    finally { setHistoryReady(true); }
  }, []);

  // ── auto-save active session ──────────────────────────────────
  useEffect(() => {
    if (!historyReady || !activeSessionId) return;
    const session: SessionSnapshot = {
      id: activeSessionId,
      title: getSessionTitle(messages),
      createdAt: Date.now(),
      messages,
      chatIndustry,
      fastTrack,
      toolContext,
      importedSources,
    };
    setAllSessions((prev) => {
      const rest = prev.filter((s) => s.id !== activeSessionId);
      const next = [session, ...rest];
      saveSessionsToStorage(next);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyReady, messages, chatIndustry, fastTrack, toolContext, importedSources]);

  // ── auto-scroll ───────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── session management ────────────────────────────────────────
  const startNewSession = () => {
    const id = makeSessionId();
    setActiveSessionId(id);
    setMessages([OPENING_MESSAGE]);
    setInput("");
    setResult(null);
    setChatError("");
    setAnalyzeError("");
    setToolContext("");
    setImportedSources([]);
    setShowSessions(false);
  };

  const switchToSession = (session: SessionSnapshot) => {
    setActiveSessionId(session.id);
    setMessages(session.messages);
    setChatIndustry(session.chatIndustry);
    setFastTrack(session.fastTrack);
    setToolContext(session.toolContext);
    setImportedSources(session.importedSources);
    setResult(null);
    setChatError("");
    setAnalyzeError("");
    setShowSessions(false);
  };

  const deleteSession = (id: string) => {
    setAllSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveSessionsToStorage(next);
      if (id === activeSessionId) {
        if (next.length > 0) {
          switchToSession(next[0]);
        } else {
          startNewSession();
        }
      }
      return next;
    });
  };

  // keep backward compat — alias no longer needed but harmless; suppress lint below

  const runToolFetch = async (
    payload: { htmlUrl?: string; documentContent?: string }
  ): Promise<IngestResponse | null> => {
    try {
      setIngestingLabel("htmlUrl" in payload ? "正在读取链接…" : "正在解析文档…");
      const response = await fetch("/api/tools/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as IngestResponse;
      if (!response.ok || !body.content) return null;
      return body;
    } catch {
      return null;
    } finally {
      setIngestingLabel("");
    }
  };

  const applyIngestResult = (result: IngestResponse, currentContext: string): string => {
    const label = `[${result.sourceType === "url" ? "网页" : "文档"}] ${result.title}`;
    const merged = currentContext
      ? `${currentContext}\n\n${label}\n${result.content}`
      : `${label}\n${result.content}`;
    setToolContext(merged);
    setImportedSources((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: result.title,
        sourceType: result.sourceType,
        chars: result.chars,
      },
    ]);
    return merged;
  };

  // Drain NDJSON stream into messages at placeholderIdx
  const drainStream = async (
    body: ReadableStream<Uint8Array>,
    placeholderIdx: number
  ) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: ReplyStreamEvent;
        try { chunk = JSON.parse(line) as ReplyStreamEvent; } catch { continue; }
        if (chunk.type === "delta" && chunk.content) {
          assistantText += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            if (updated[placeholderIdx]?.role === "assistant") {
              updated[placeholderIdx] = { role: "assistant", content: assistantText };
            }
            return updated;
          });
        }
        if (chunk.type === "error") throw new Error(chunk.error || "流式对话失败，请稍后重试。");
      }
    }

    if (!assistantText.trim()) {
      setMessages((prev) => {
        const updated = [...prev];
        if (updated[placeholderIdx]?.role === "assistant" && !updated[placeholderIdx].content.trim()) {
          updated.splice(placeholderIdx, 1);
        }
        return updated;
      });
      throw new Error("未收到模型回复，请稍后重试。");
    }
  };

  // Send a conversation chain to /api/distill and stream the reply
  const dispatchToDistill = async (
    conversationMessages: ChatMessage[],
    activeToolContext: string,
    messagesAlreadySet = false
  ) => {
    const placeholderIdx = conversationMessages.length;
    if (messagesAlreadySet) {
      // Messages already rendered — just append the assistant placeholder
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    } else {
      setMessages([...conversationMessages, { role: "assistant", content: "" }]);
    }
    setChatError("");
    setChatLoading(true);
    try {
      const response = await fetch("/api/distill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "reply",
          messages: conversationMessages,
          industry: chatIndustry,
          fastTrack,
          stream: true,
          toolContext: activeToolContext,
        }),
      });
      if (!response.ok || !response.body) {
        const maybeJson = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(maybeJson?.error || "对话失败，请稍后重试。");
      }
      await drainStream(response.body, placeholderIdx);
    } catch (error) {
      setMessages((prev) => {
        const updated = [...prev];
        if (updated[updated.length - 1]?.role === "assistant" && !updated[updated.length - 1].content.trim()) {
          updated.pop();
        }
        return updated;
      });
      setChatError(error instanceof Error ? error.message : "对话失败，请稍后重试。");
    } finally {
      setChatLoading(false);
    }
  };

  // + button: attach file → agent tool call → auto-trigger reply
  const handleAttachFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text().catch(() => "");
    if (!text.trim()) return;

    const result = await runToolFetch({ documentContent: text.slice(0, 20000) });
    if (!result) return;

    const activeToolContext = applyIngestResult(result, toolContext);
    const toolCallMsg: ChatMessage = {
      role: "assistant",
      content: `【tool:read_document】标题：${result.title}，共 ${result.chars.toLocaleString()} 字`,
    };
    const toolResultMsg: ChatMessage = {
      role: "user",
      content: `【tool_result】文档《${result.title}》内容已加载完毕（${result.chars.toLocaleString()} 字），请基于文档内容继续访谈。`,
    };
    await dispatchToDistill([...messages, toolCallMsg, toolResultMsg], activeToolContext);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!input.trim() || chatLoading) return;
    void sendMessage(event as unknown as FormEvent<HTMLFormElement>);
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || chatLoading) return;

    setInput("");

    const userMsg: ChatMessage = { role: "user", content: text };
    // Immediately show user message in UI so the chat doesn't feel frozen
    setMessages((prev) => [...prev, userMsg]);

    let conversationMessages: ChatMessage[] = [...messages, userMsg];
    let activeToolContext = toolContext;

    // Agent tool call: URL detected → fetch → inject tool-call + tool-result into message chain
    const urlMatch = text.match(/https?:\/\/[^\s，。！？""'']+/);
    if (urlMatch) {
      const result = await runToolFetch({ htmlUrl: urlMatch[0] });
      if (result) {
        activeToolContext = applyIngestResult(result, activeToolContext);
        const toolCallMsg: ChatMessage = {
          role: "assistant",
          content: `【tool:fetch_url】读取链接《${result.title}》，共 ${result.chars.toLocaleString()} 字`,
        };
        const toolResultMsg: ChatMessage = {
          role: "user",
          content: `【tool_result】链接内容《${result.title}》已全量加载（${result.chars.toLocaleString()} 字）。请基于该内容继续访谈。`,
        };
        // Append tool-call chip to visible messages
        setMessages((prev) => [...prev, toolCallMsg, toolResultMsg]);
        conversationMessages = [...conversationMessages, toolCallMsg, toolResultMsg];
      }
    }

    await dispatchToDistill(conversationMessages, activeToolContext, true);
  };

  const generateReport = async () => {
    if (userTurnCount < 2 || analyzing) return;

    setAnalyzing(true);
    setAnalyzeError("");
    setLeadMessage("");
    try {
      const response = await fetch("/api/distill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "report",
          messages,
          industry: chatIndustry,
          fastTrack,
          toolContext,
        }),
      });

      const body = (await response.json()) as AnalyzeResponse & { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "生成报告失败，请稍后重试。");
      }

      setResult(body);
    } catch (error) {
      setAnalyzeError(error instanceof Error ? error.message : "生成报告失败，请稍后重试。");
    } finally {
      setAnalyzing(false);
    }
  };

  const onLeadSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!result) return;

    setLeadLoading(true);
    setLeadMessage("");

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: leadName,
          email: leadEmail,
          wechat: leadWechat,
          industry: leadIndustry,
          score: result.score.total,
          tier: result.score.tier,
          dimensions: result.score.dimensions,
          consent: leadConsent,
        }),
      });

      const body = (await response.json()) as { error?: string; leadId?: string };
      if (!response.ok) {
        throw new Error(body.error || "留资失败，请稍后重试。");
      }

      setLeadMessage(`提交成功，你的评估档案编号：${body.leadId}`);
    } catch (error) {
      setLeadMessage(error instanceof Error ? error.message : "留资失败，请稍后重试。");
    } finally {
      setLeadLoading(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <section className="flex items-baseline gap-4 px-1">
        <h1 className="text-xl font-black text-slate-900 sm:text-2xl">
          你会被AI替代吗？测算你的<span className="bg-gradient-to-r from-accent-2 to-accent bg-clip-text text-transparent">不可替代指数</span>
        </h1>
        <p className="text-sm text-slate-500">通过深度追问，提炼那些机器无法复制的隐性专业价值</p>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="glass-card rounded-3xl p-6 sm:p-8">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-black text-slate-900">深度追问</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-slate-500">
                深度演进：第 {userTurnCount} 轮
              </span>
              <button
                type="button"
                onClick={() => setShowSessions((v) => !v)}
                className="text-xs text-slate-400 hover:text-slate-600 underline underline-offset-2"
              >
                历史对话
              </button>
              <button
                type="button"
                onClick={startNewSession}
                className="text-xs text-slate-400 hover:text-slate-600 underline underline-offset-2"
              >
                新对话
              </button>
            </div>
          </div>
          <p className="mt-2 text-sm text-slate-600">
            真正有价值的判断往往不在简历里。用脱敏信息描述你的真实决策过程——那是机器最难学会的部分。
          </p>

          {/* Sessions panel */}
          {showSessions && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1 max-h-52 overflow-y-auto">
              {allSessions.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-2">暂无历史对话</p>
              ) : (
                allSessions.map((s) => (
                  <div
                    key={s.id}
                    className={`flex items-center justify-between rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                      s.id === activeSessionId
                        ? "bg-emerald-50 border border-emerald-200"
                        : "hover:bg-white"
                    }`}
                    onClick={() => switchToSession(s)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-xs font-medium ${s.id === activeSessionId ? "text-emerald-700" : "text-slate-700"}`}>
                        {s.title}
                      </p>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {new Date(s.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        &nbsp;·&nbsp;{s.messages.filter((m) => m.role === "user").length} 轮
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                      className="ml-2 shrink-0 rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-400 transition-colors"
                      title="删除此对话"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {ingestingLabel ? (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2">
              <p className="text-xs text-slate-400 animate-pulse">{ingestingLabel}</p>
            </div>
          ) : importedSources.length > 0 ? (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2">
              <p className="text-xs text-slate-500">
                已解析资料：
                {importedSources.map((s, i) => (
                  <span key={s.id}>{i > 0 ? "、" : ""}{s.title}（{s.chars} 字）</span>
                ))}
              </p>
            </div>
          ) : null}

          <div ref={chatContainerRef} className="mt-5 h-[420px] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4">
            <div className="space-y-4">
              {messages.map((message, idx) => {
                // tool_result messages are internal — hide from user
                if (message.content.startsWith("【tool_result】")) return null;

                // tool-call messages render as a small action chip
                if (message.content.startsWith("【tool:")) {
                  const label = message.content.replace(/^【tool:[^】]+】/, "").trim();
                  return (
                    <div key={`tool-${idx}`} className="flex items-center gap-1.5 text-xs text-slate-400">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                      <span>{label}</span>
                    </div>
                  );
                }

                return (
                  <div
                    key={`${message.role}-${idx}`}
                    className={`max-w-[88%] rounded-xl px-4 py-3 text-sm leading-7 ${
                      message.role === "assistant"
                        ? "bg-slate-100 text-slate-700"
                        : "ml-auto bg-emerald-600 text-white"
                    }`}
                  >
                    {message.role === "assistant" &&
                    chatLoading &&
                    !message.content.trim() ? (
                      <span className="inline-flex items-center gap-2 text-slate-500">
                        <span>AI 正在思考</span>
                        <span className="animate-pulse">...</span>
                      </span>
                    ) : (
                      message.role === "assistant"
                        ? (
                          <div className="prose prose-sm max-w-none text-slate-700">
                            <ReactMarkdown components={markdownComponents}>
                              {message.content}
                            </ReactMarkdown>
                          </div>
                        )
                        : message.content
                    )}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <form className="mt-4" onSubmit={sendMessage}>
            {/* Gemini-style unified input container */}
            <div className="rounded-2xl border border-slate-300 bg-white transition-shadow focus-within:shadow-sm focus-within:ring-2 focus-within:ring-accent/20">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleInputKeyDown}
                rows={3}
                placeholder="聊聊你的真实思考，越反直觉的经验，护城河越深……"
                className="w-full resize-none rounded-t-2xl px-4 pt-4 pb-1 text-sm outline-none placeholder:text-slate-400"
              />
              {/* bottom action bar */}
              <div className="flex items-center gap-2 px-3 pb-3 pt-1">
                {/* + file attachment */}
                <label
                  title="上传文档（.txt .md .html）"
                  className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 active:bg-slate-100"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  <input
                    type="file"
                    accept=".txt,.md,.html,.htm"
                    onChange={handleAttachFile}
                    className="hidden"
                  />
                </label>

                <span className="flex-1" />

                {/* generate report */}
                <button
                  type="button"
                  onClick={generateReport}
                  disabled={
                    analyzing ||
                    userTurnCount < (fastTrack ? 1 : BACKGROUND_COLLECTION_MIN_TURNS)
                  }
                  className="h-9 rounded-xl px-3 text-xs font-semibold text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {analyzing ? "测算中…" : "生成报告"}
                </button>

                {/* send */}
                <button
                  type="submit"
                  disabled={chatLoading || !input.trim()}
                  title="发送（Enter）"
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {chatLoading ? (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            {chatError ? <p className="mt-2 text-sm font-medium text-red-600">{chatError}</p> : null}
            {analyzeError ? <p className="mt-2 text-sm font-medium text-red-600">{analyzeError}</p> : null}
          </form>
        </div>

        <div className="glass-card rounded-3xl p-6 sm:p-8">
          <h2 className="text-2xl font-black text-slate-900">不可替代指数报告</h2>
          {!result ? (
            <p className="mt-6 text-sm leading-7 text-slate-600">
              AI每天都在&ldquo;学习&rdquo;你的行业。完成追问后，这里将生成你的不可替代指数评分——哪些能力机器还拿不走，哪些正面临被替代的风险，以及你该如何加固护城河。
            </p>
          ) : (
            <div className="mt-6 space-y-5">
              <div className="rounded-2xl bg-gradient-to-r from-accent-2 to-accent p-[1px]">
                <div className="rounded-2xl bg-white px-5 py-4">
                  <p className="text-sm text-slate-500">你的不可替代指数</p>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className="text-5xl font-black text-slate-900">{result.score.total}</span>
                    <span className="rounded-full bg-slate-900 px-2 py-1 text-xs font-semibold text-white">
                      {result.score.tier}
                    </span>
                  </div>
                </div>
              </div>

              {narrative ? (
                <div className="space-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <p className="text-sm font-semibold text-slate-900">{narrative.title}</p>
                  <p className="text-sm text-slate-600">风险提示：{narrative.risk}</p>
                </div>
              ) : null}

              <div className="space-y-2">
                <p className="text-sm font-bold text-slate-900">不可替代性摘要</p>
                <p className="text-sm leading-7 text-slate-700">{result.distillation.summary}</p>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-bold text-slate-900">机器难以复制的能力</p>
                <ul className="space-y-2 text-sm text-slate-700">
                  {result.distillation.uniqueSignals.map((item) => (
                    <li key={item} className="rounded-lg bg-white px-3 py-2">
                      • {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-bold text-slate-900">高度可替代的风险区</p>
                <ul className="space-y-2 text-sm text-slate-700">
                  {result.distillation.riskSignals.map((item) => (
                    <li key={item} className="rounded-lg bg-amber-50 px-3 py-2">
                      • {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-bold text-slate-900">强化不可替代性：7 天行动</p>
                <ul className="space-y-2 text-sm text-slate-700">
                  {result.distillation.actionPlan.map((item) => (
                    <li key={item} className="rounded-lg bg-emerald-50 px-3 py-2">
                      • {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </section>

      {result ? (
        <section className="glass-card rounded-3xl p-6 sm:p-8">
          <h3 className="text-xl font-black text-slate-900">领取完整不可替代指数报告</h3>
          <p className="mt-2 text-sm text-slate-600">
            留下联系方式，接收完整的六维不可替代指数分析，以及专属的 30 分钟人机竞合诊断。
          </p>

          <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={onLeadSubmit}>
            <label className="space-y-1">
              <span className="field-label">姓名</span>
              <input
                value={leadName}
                onChange={(e) => setLeadName(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-accent/20 focus:ring"
              />
            </label>
            <label className="space-y-1">
              <span className="field-label">邮箱</span>
              <input
                type="email"
                value={leadEmail}
                onChange={(e) => setLeadEmail(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-accent/20 focus:ring"
              />
            </label>
            <label className="space-y-1">
              <span className="field-label">微信（可选）</span>
              <input
                value={leadWechat}
                onChange={(e) => setLeadWechat(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-accent/20 focus:ring"
              />
            </label>
            <label className="space-y-1">
              <span className="field-label">行业</span>
              <select
                value={leadIndustry}
                onChange={(e) => setLeadIndustry(e.target.value as ExpertIndustry)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-accent/20 focus:ring"
              >
                {INDUSTRIES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="sm:col-span-2 flex items-start gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={leadConsent}
                onChange={(e) => setLeadConsent(e.target.checked)}
                className="mt-1 accent-accent"
              />
              我同意接收后续的评估解读与产品更新。
            </label>

            <button
              type="submit"
              disabled={leadLoading}
              className="button-primary h-11 rounded-xl px-5 text-sm font-bold sm:col-span-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {leadLoading ? "提交中..." : "提交并领取完整报告"}
            </button>

            {leadMessage ? (
              <p className="sm:col-span-2 text-sm font-medium text-slate-700">{leadMessage}</p>
            ) : null}
          </form>
        </section>
      ) : null}
    </main>
  );
}
