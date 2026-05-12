import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { calculateScore, type AssessmentAnswers } from "@/lib/scoring";
import {
  BACKGROUND_COLLECTION_MIN_TURNS,
  buildInterviewPlanPrompt,
  buildInterviewReplanPrompt,
  buildReportPrompt,
  buildInterviewSystemPrompt,
  getFallbackQuestion,
  type ExpertIndustry,
  type PromptChatMessage,
} from "@/lib/prompts";

type ChatMessage = PromptChatMessage;

type DistillPayload = {
  mode?: "reply" | "report" | "plan";
  messages?: ChatMessage[];
  industry?: ExpertIndustry;
  fastTrack?: boolean;
  stream?: boolean;
  toolContext?: string;
  sessionId?: string;
  interviewPlan?: string[];
};

type DistillOutput = {
  summary: string;
  uniqueSignals: string[];
  riskSignals: string[];
  actionPlan: string[];
  strategyPlan: string[];
};

type PlanOutput = {
  plan: string[];
  summary: string;
};

const BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.7-highspeed";
const DEFAULT_INDUSTRY: ExpertIndustry = "其他";
const LOG_DIR = path.join(process.cwd(), "data", "chat-logs");
const REPLAN_TIMEOUT_MS = 1200;

type SessionLog = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  events: Array<Record<string, unknown>>;
};

function normalizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").trim();
  return cleaned || "unknown-session";
}

async function logChatEvent(
  sessionId: string,
  record: Record<string, unknown>
): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });

    const normalizedSessionId = normalizeSessionId(sessionId);
    const logFile = path.join(LOG_DIR, `${normalizedSessionId}.json`);
    const now = new Date().toISOString();

    let current: SessionLog | null = null;
    try {
      const raw = await readFile(logFile, "utf8");
      const parsed = JSON.parse(raw) as SessionLog;
      if (parsed && Array.isArray(parsed.events)) {
        current = parsed;
      }
    } catch {
      current = null;
    }

    const next: SessionLog = current ?? {
      sessionId: normalizedSessionId,
      createdAt: now,
      updatedAt: now,
      events: [],
    };

    next.updatedAt = now;
    next.events.push(record);

    await writeFile(logFile, JSON.stringify(next, null, 2), "utf8");
  } catch {
    // Never let logging errors surface to the user
  }
}

function getReplyStage(userTurns: number, fastTrack: boolean) {
  if (fastTrack) return "fast-track";
  return userTurns < BACKGROUND_COLLECTION_MIN_TURNS
    ? "background-collection"
    : "deep-analysis";
}

function normalizePlanItems(plan: unknown, maxLen = 8): string[] {
  if (!Array.isArray(plan)) return [];
  return plan
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, maxLen);
}

type ReplanOutput = {
  plan: string[];
  summary: string;
};

function createFallbackReplyStream(
  reply: string,
  stage: string,
  onFinalReply?: (assistantReply: string, status: "done" | "error") => void,
  doneMeta?: { interviewPlan?: string[]; planUpdated?: boolean }
) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanedReply = sanitizeModelText(reply);
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({ type: "delta", content: cleanedReply })}\n`
        )
      );
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({ type: "done", stage, ...doneMeta })}\n`
        )
      );
      onFinalReply?.(cleanedReply, "done");
      controller.close();
    },
  });
}

async function createMiniMaxReplyStream(
  messages: ChatMessage[],
  industry: ExpertIndustry,
  fastTrack: boolean,
  stage: string,
  toolContext: string,
  interviewPlan: string[],
  onFinalReply?: (assistantReply: string, status: "done" | "error") => void,
  doneMeta?: { interviewPlan?: string[]; planUpdated?: boolean }
): Promise<ReadableStream<Uint8Array>> {
  const key = process.env.MINIMAX_API_KEY;
  const userTurnCount = messages.filter((m) => m.role === "user").length;

  if (!key) {
    return createFallbackReplyStream(
      fallbackReply(messages, industry, fastTrack),
      stage,
      onFinalReply,
      doneMeta
    );
  }

  const modelMessages = [
    {
      role: "system",
      content:
        buildInterviewSystemPrompt(industry, userTurnCount, fastTrack, interviewPlan) +
        (toolContext ? `\n\n外部资料参考（优先用于追问与校验）：\n${toolContext}` : ""),
    },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const upstream = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: modelMessages,
      temperature: 0.7,
      n: 1,
      stream: true,
      max_completion_tokens: 600,
      reasoning_split: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    return createFallbackReplyStream(
      fallbackReply(messages, industry, fastTrack),
      stage,
      onFinalReply,
      doneMeta
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let assistantReply = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: { content?: string };
                  message?: { content?: string };
                }>;
              };

              const delta =
                parsed.choices?.[0]?.delta?.content ??
                parsed.choices?.[0]?.message?.content ??
                "";
              if (!delta) continue;

              assistantReply += delta;

              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({
                    type: "delta",
                    content: delta,
                  })}\n`
                )
              );
            } catch {
              // Ignore malformed streaming chunks.
            }
          }
        }

        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "done", stage, ...doneMeta })}\n`
          )
        );
        onFinalReply?.(sanitizeModelText(assistantReply), "done");
        controller.close();
      } catch {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "error",
              error: "流式对话中断，请重试。",
            })}\n`
          )
        );
        onFinalReply?.(sanitizeModelText(assistantReply), "error");
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function sanitizeModelText(raw: string): string {
  let text = raw;

  // Remove XML-like think blocks if model returns chain-of-thought.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // Remove markdown fenced blocks explicitly marked as think/reasoning.
  text = text.replace(/```(?:think|reasoning)[\s\S]*?```/gi, "");

  // Remove leading labels sometimes used by models.
  text = text.replace(/^\s*(思考过程|推理过程|reasoning|thinking)\s*[:：].*$/gim, "");

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function validateMessages(input: unknown): input is ChatMessage[] {
  if (!Array.isArray(input) || input.length === 0) return false;
  return input.every(
    (item) =>
      item &&
      (item as ChatMessage).role &&
      ((item as ChatMessage).role === "user" ||
        (item as ChatMessage).role === "assistant") &&
      typeof (item as ChatMessage).content === "string"
  );
}

function resolveIndustry(input: unknown): ExpertIndustry {
  const allowed: ExpertIndustry[] = [
    "科技互联网",
    "金融与投资",
    "制造与供应链",
    "教育与培训",
    "医疗与健康",
    "消费与零售",
    "其他",
  ];
  if (typeof input !== "string") return DEFAULT_INDUSTRY;
  return allowed.includes(input as ExpertIndustry)
    ? (input as ExpertIndustry)
    : DEFAULT_INDUSTRY;
}

function extractJson(raw: string): DistillOutput | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as DistillOutput;
    if (
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.uniqueSignals) &&
      Array.isArray(parsed.riskSignals) &&
      Array.isArray(parsed.actionPlan)
    ) {
      return {
        summary: parsed.summary,
        uniqueSignals: parsed.uniqueSignals.slice(0, 4),
        riskSignals: parsed.riskSignals.slice(0, 4),
        actionPlan: parsed.actionPlan.slice(0, 3),
        strategyPlan: Array.isArray(parsed.strategyPlan)
          ? parsed.strategyPlan.slice(0, 4)
          : [],
      };
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeToolContext(input: unknown): string {
  if (typeof input !== "string") return "";
  const cleaned = input.trim();
  if (!cleaned) return "";
  if (cleaned.length <= 12000) return cleaned;
  return `${cleaned.slice(0, 12000)}\n\n[外部资料过长，已截断]`;
}

function fallbackDistill(answers: AssessmentAnswers): DistillOutput {
  const strengths: string[] = [];
  const risks: string[] = [];

  if (answers.problemDefinition >= 4) {
    strengths.push("你在问题定义上具备较强的结构化能力。");
  }
  if (answers.crossDomainSynthesis >= 4) {
    strengths.push("你具备跨领域整合能力，适合做复杂问题决策。");
  }
  if (answers.methodologyTransferability >= 4) {
    strengths.push("你有将经验方法化的潜力，便于团队复制。");
  }

  if (answers.aiCollaboration <= 2) {
    risks.push("AI 协同深度偏浅，短期会影响交付效率放大。");
  }
  if (answers.orgMomentum <= 2) {
    risks.push("组织推动力偏弱，可能导致方案难落地。");
  }
  if (!answers.next90DaysPlan.trim()) {
    risks.push("90 天执行计划不清晰，难形成持续增益。");
  }

  return {
    summary:
      "你具备可提炼的专业判断能力，当前重点是把经验框架化，并通过 AI 协同持续放大交付效率。",
    uniqueSignals: strengths.length
      ? strengths
      : ["你的实战经验已具备形成方法论的基础。"],
    riskSignals: risks.length
      ? risks
      : ["建议尽快建立可复用模板，避免优势停留在个人经验。"],
    actionPlan: [
      "30 天内完成一个高频场景的分析模板（问题、变量、证据、结论）。",
      "将最近一次案例复盘为可复用流程，建立团队共享版本。",
      "每周固定一次 AI 协同回顾，跟踪效率提升与质量波动。",
    ],
    strategyPlan: [
      "构建个人方法论体系：将核心判断框架文档化，形成可传授的知识资产。",
      "差异化定位：识别行业内 AI 难以替代的 3 个细分场景，聚焦深耕。",
      "AI 协同升级：系统学习 1-2 个与本职工作深度结合的 AI 工具，提升交付杠杆。",
      "建立外部影响力：通过内容输出或社群参与，将隐性经验转化为可见的专业品牌。",
    ],
  };
}

function deriveAnswersFromMessages(messages: ChatMessage[]): AssessmentAnswers {
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean);
  const merged = userTexts.join("\n");
  const longText = merged.length;
  const keywordCount = (text: string, words: string[]) =>
    words.reduce((acc, word) => acc + (text.includes(word) ? 1 : 0), 0);

  const industryDepth = Math.min(5, 2 + Math.floor(longText / 500));
  const problemDefinition = Math.min(
    5,
    2 + keywordCount(merged, ["根因", "假设", "变量", "约束", "复盘"])
  );
  const crossDomainSynthesis = Math.min(
    5,
    2 + keywordCount(merged, ["跨部门", "跨行业", "协同", "整合", "多方"])
  );
  const orgMomentum = Math.min(
    5,
    2 + keywordCount(merged, ["推动", "落地", "执行", "里程碑", "管理层"])
  );
  const aiCollaboration = Math.min(
    5,
    2 + keywordCount(merged, ["AI", "模型", "自动化", "提示词", "工作流"])
  );
  const methodologyTransferability = Math.min(
    5,
    2 + keywordCount(merged, ["模板", "方法论", "标准化", "复用", "SOP"])
  );

  return {
    industryDepth,
    problemDefinition,
    crossDomainSynthesis,
    orgMomentum,
    aiCollaboration,
    methodologyTransferability,
    uniqueCase: userTexts[0] || "用户尚未提供明确案例。",
    antiCase: userTexts[1] || userTexts[0] || "用户尚未提供失败修正案例。",
    next90DaysPlan: userTexts[userTexts.length - 1] || "用户尚未提供明确90天计划。",
  };
}

function fallbackReply(
  messages: ChatMessage[],
  industry: ExpertIndustry,
  fastTrack: boolean
): string {
  const userTurns = messages.filter((m) => m.role === "user").length;
  return getFallbackQuestion(industry, userTurns, fastTrack);
}

async function callMiniMaxForReply(
  messages: ChatMessage[],
  industry: ExpertIndustry,
  fastTrack: boolean,
  toolContext: string,
  interviewPlan: string[]
): Promise<string | null> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return null;

  const userTurnCount = messages.filter((m) => m.role === "user").length;

  const modelMessages = [
    {
      role: "system",
      content:
        buildInterviewSystemPrompt(industry, userTurnCount, fastTrack, interviewPlan) +
        (toolContext ? `\n\n外部资料参考（优先用于追问与校验）：\n${toolContext}` : ""),
    },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: modelMessages,
      temperature: 0.7,
      n: 1,
      stream: false,
      max_completion_tokens: 600,
      reasoning_split: true,
    }),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const raw = data.choices?.[0]?.message?.content;
  if (!raw) return null;

  const cleaned = sanitizeModelText(raw);
  return cleaned || null;
}

function fallbackPlan(toolContext: string, messages: ChatMessage[] = []): PlanOutput {
  const base = toolContext.trim();
  const hasMaterial = base.length > 0;
  const userTurns = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean);
  const latestUserTurn = userTurns[userTurns.length - 1] || "";
  return {
    plan: hasMaterial
      ? [
          "先确认资料中最关键的一段实战场景：当时目标、角色与约束是什么？",
          "追问该场景中的关键判断：你当时为何否定了其他可选方案？",
          "拆解取舍过程：在时间、风险、资源冲突下，你优先保护了什么？",
          "回看结果与复盘：哪些信号验证了你的判断，哪些地方被你修正？",
          "提炼可迁移方法：如果让新人复现，你会给哪三条不可省略的判断准则？",
        ]
      : [
          latestUserTurn
            ? `先从你刚提到的这段经历展开：${latestUserTurn.slice(0, 40)}…当时你的目标和角色分别是什么？`
            : "先用一个最近的真实场景开场：你当时的目标、角色和约束分别是什么？",
          "追问关键判断：在多个可选方案里，你为什么先排除了其他选项？",
          "拆解决策取舍：时间、资源、风险冲突时，你优先保护了什么？",
          "回看结果与修正：哪些信号证明判断有效，哪些地方后来被你改写？",
          "沉淀可迁移方法：如果让新人复现，你会给出哪三条判断准则？",
        ],
    summary: "按场景-判断-取舍-结果-迁移的路径逐层深挖，确保访谈有结构且可落地。",
  };
}

async function callMiniMaxForPlan(
  toolContext: string,
  industry: ExpertIndustry,
  conversationContext: string
): Promise<PlanOutput | null> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return null;

  const prompt = buildInterviewPlanPrompt(toolContext, industry, conversationContext);

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      n: 1,
      stream: false,
      max_completion_tokens: 900,
    }),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;

  const cleaned = sanitizeModelText(content);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as PlanOutput;
    if (!Array.isArray(parsed.plan)) return null;
    const plan = parsed.plan
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean)
      .slice(0, 5);
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (plan.length === 0) return null;
    return { plan, summary };
  } catch {
    return null;
  }
}

async function callMiniMaxForReplan(
  messages: ChatMessage[],
  industry: ExpertIndustry,
  toolContext: string,
  currentPlan: string[]
): Promise<ReplanOutput | null> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return null;

  const conversationContext = messages
    .slice(-12)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const prompt = buildInterviewReplanPrompt(
    industry,
    currentPlan,
    conversationContext,
    toolContext
  );

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      n: 1,
      stream: false,
      max_completion_tokens: 900,
    }),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;

  const cleaned = sanitizeModelText(content);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as ReplanOutput;
    const plan = normalizePlanItems(parsed.plan, 8);
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (plan.length === 0) return null;
    return { plan, summary };
  } catch {
    return null;
  }
}

async function maybeReplanInterviewPlan(
  messages: ChatMessage[],
  industry: ExpertIndustry,
  toolContext: string,
  currentPlan: string[]
): Promise<{ plan: string[]; updated: boolean; summary?: string }> {
  const hasUserTurns = messages.some((m) => m.role === "user" && m.content.trim());
  if (currentPlan.length === 0 && !toolContext && !hasUserTurns) {
    return { plan: currentPlan, updated: false };
  }

  const replanResult = await Promise.race([
    callMiniMaxForReplan(messages, industry, toolContext, currentPlan),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), REPLAN_TIMEOUT_MS);
    }),
  ]);

  if (!replanResult || replanResult.plan.length === 0) {
    if (currentPlan.length === 0 && hasUserTurns) {
      const bootstrapped = fallbackPlan(toolContext, messages).plan;
      return { plan: bootstrapped, updated: true };
    }
    return { plan: currentPlan, updated: false };
  }

  const nextPlan = normalizePlanItems(replanResult.plan, 8);
  const updated = JSON.stringify(nextPlan) !== JSON.stringify(currentPlan);
  return { plan: nextPlan, updated, summary: replanResult.summary };
}

async function callMiniMaxForReport(
  messages: ChatMessage[],
  industry: ExpertIndustry,
  toolContext: string
): Promise<{
  report: DistillOutput;
  answers: AssessmentAnswers;
} | null> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return null;

  const prompt = buildReportPrompt(messages, industry, toolContext);

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      n: 1,
      stream: false,
      max_completion_tokens: 1800,
    }),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;

  const cleanedContent = sanitizeModelText(content);

  console.log("[distill/report] raw model output (first 800 chars):", cleanedContent.slice(0, 800));

  const start = cleanedContent.indexOf("{");
  const end = cleanedContent.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(cleanedContent.slice(start, end + 1)) as {
      answers: AssessmentAnswers;
      summary: string;
      uniqueSignals: string[];
      riskSignals: string[];
      actionPlan: string[];
      strategyPlan: string[];
    };

    const report = extractJson(
      JSON.stringify({
        summary: parsed.summary,
        uniqueSignals: parsed.uniqueSignals,
        riskSignals: parsed.riskSignals,
        actionPlan: parsed.actionPlan,
        strategyPlan: parsed.strategyPlan,
      })
    );
    if (!report) return null;

    return { report, answers: parsed.answers };
  } catch {
    return null;
  }
}

async function buildReportResult(
  messages: ChatMessage[],
  industry: ExpertIndustry,
  toolContext: string
) {
  const reportFromModel = await callMiniMaxForReport(messages, industry, toolContext);
  const answers = reportFromModel?.answers ?? deriveAnswersFromMessages(messages);
  const report = reportFromModel?.report ?? fallbackDistill(answers);
  const score = calculateScore(answers);

  return {
    answers,
    report,
    score,
    modelUsed: reportFromModel ? "LLM" : "fallback",
  };
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as DistillPayload;
    const mode = payload.mode || "reply";

    if (mode !== "plan" && !validateMessages(payload.messages)) {
      return NextResponse.json(
        { error: "无效输入，请检查对话内容。" },
        { status: 400 }
      );
    }

    const messages = payload.messages ?? [];
    const industry = resolveIndustry(payload.industry);
    const fastTrack = Boolean(payload.fastTrack);
    const stream = Boolean(payload.stream);
    const toolContext = normalizeToolContext(payload.toolContext);
    const interviewPlan = normalizePlanItems(payload.interviewPlan, 8);
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId
      ? payload.sessionId
      : randomUUID();

    if (mode === "plan") {
      if (payload.messages && !validateMessages(payload.messages)) {
        return NextResponse.json(
          { error: "访谈计划生成失败：对话内容格式无效。" },
          { status: 400 }
        );
      }

      const conversationContext = messages
        .filter((m) => m.role === "user")
        .slice(-6)
        .map((m) => m.content.trim())
        .filter(Boolean)
        .join("\n");

      const planResult =
        (await callMiniMaxForPlan(toolContext, industry, conversationContext)) ??
        fallbackPlan(toolContext, messages);
      void logChatEvent(sessionId, {
        event: "plan",
        ts: new Date().toISOString(),
        sessionId,
        industry,
        plan: planResult.plan,
        summary: planResult.summary,
      });
      return NextResponse.json(planResult);
    }

    if (mode === "reply") {
      const userTurns = messages.filter((m) => m.role === "user").length;
      const stage = getReplyStage(userTurns, fastTrack);
      const replanResult = await maybeReplanInterviewPlan(
        messages,
        industry,
        toolContext,
        interviewPlan
      );
      const effectiveInterviewPlan = replanResult.plan;

      // Log full request snapshot for every reply turn.
      void logChatEvent(sessionId, {
        event: "reply_request",
        ts: new Date().toISOString(),
        sessionId,
        industry,
        fastTrack,
        stream,
        stage,
        userTurnCount: userTurns,
        messages,
        toolContext,
        interviewPlan: effectiveInterviewPlan,
        replanUpdated: replanResult.updated,
        replanSummary: replanResult.summary,
      });

      if (stream) {
        const replyStream = await createMiniMaxReplyStream(
          messages,
          industry,
          fastTrack,
          stage,
          toolContext,
          effectiveInterviewPlan,
          (assistantReply, status) => {
            void logChatEvent(sessionId, {
              event: "reply_response",
              ts: new Date().toISOString(),
              sessionId,
              status,
              assistantReply,
            });
          },
          {
            interviewPlan: effectiveInterviewPlan,
            planUpdated: replanResult.updated,
          }
        );

        return new Response(replyStream, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
          },
        });
      }

      const assistantReply =
        (await callMiniMaxForReply(
          messages,
          industry,
          fastTrack,
          toolContext,
          effectiveInterviewPlan
        )) ??
        fallbackReply(messages, industry, fastTrack);

      void logChatEvent(sessionId, {
        event: "reply_response",
        ts: new Date().toISOString(),
        sessionId,
        status: "done",
        assistantReply,
      });

      return NextResponse.json({
        assistantReply,
        stage,
        interviewPlan: effectiveInterviewPlan,
        planUpdated: replanResult.updated,
      });
    }

    if (stream) {
      const encoder = new TextEncoder();
      const reportStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = (chunk: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
          };

          try {
            emit({
              type: "status",
              stage: "collecting",
              progress: 12,
              message: "正在整理你的访谈关键信号…",
            });

            const reportResult = await buildReportResult(messages, industry, toolContext);

            emit({
              type: "status",
              stage: "scoring",
              progress: 76,
              message: "正在计算不可替代指数与维度分布…",
            });

            emit({
              type: "status",
              stage: "finalizing",
              progress: 92,
              message: "正在生成行动建议与发展策略…",
            });

            console.log("[distill/report] answers:", JSON.stringify(reportResult.answers));
            console.log("[distill/report] score:", JSON.stringify(reportResult.score));
            console.log("[distill/report] modelUsed:", reportResult.modelUsed);

            // Log full session on report generation (fire-and-forget)
            void logChatEvent(sessionId, {
              event: "report",
              ts: new Date().toISOString(),
              sessionId,
              industry,
              fastTrack,
              userTurnCount: messages.filter((m) => m.role === "user").length,
              messages,
              answers: reportResult.answers,
              score: reportResult.score,
              distillation: reportResult.report,
            });

            emit({
              type: "result",
              distillation: reportResult.report,
              score: reportResult.score,
              answers: reportResult.answers,
            });
            emit({
              type: "done",
              progress: 100,
              message: "报告已完成",
            });
            controller.close();
          } catch (error) {
            console.error("[distill/report] stream error:", error);
            emit({ type: "error", error: "报告生成失败，请稍后重试。" });
            controller.close();
          }
        },
      });

      return new Response(reportStream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }

    const reportResult = await buildReportResult(messages, industry, toolContext);

    console.log("[distill/report] answers:", JSON.stringify(reportResult.answers));
    console.log("[distill/report] score:", JSON.stringify(reportResult.score));
    console.log("[distill/report] modelUsed:", reportResult.modelUsed);

    // Log full session on report generation (fire-and-forget)
    void logChatEvent(sessionId, {
      event: "report",
      ts: new Date().toISOString(),
      sessionId,
      industry,
      fastTrack,
      userTurnCount: messages.filter((m) => m.role === "user").length,
      messages,
      answers: reportResult.answers,
      score: reportResult.score,
      distillation: reportResult.report,
    });

    return NextResponse.json({
      distillation: reportResult.report,
      score: reportResult.score,
      answers: reportResult.answers,
    });
  } catch (err) {
    console.error("[distill] unexpected error:", err);
    return NextResponse.json(
      { error: "分析失败，请稍后重试。" },
      { status: 500 }
    );
  }
}