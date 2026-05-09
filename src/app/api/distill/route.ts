import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { calculateScore, type AssessmentAnswers } from "@/lib/scoring";
import {
  BACKGROUND_COLLECTION_MIN_TURNS,
  buildReportPrompt,
  buildInterviewSystemPrompt,
  getFallbackQuestion,
  type ExpertIndustry,
  type PromptChatMessage,
} from "@/lib/prompts";

type ChatMessage = PromptChatMessage;

type DistillPayload = {
  mode?: "reply" | "report";
  messages?: ChatMessage[];
  industry?: ExpertIndustry;
  fastTrack?: boolean;
  stream?: boolean;
  toolContext?: string;
  sessionId?: string;
};

type DistillOutput = {
  summary: string;
  uniqueSignals: string[];
  riskSignals: string[];
  actionPlan: string[];
  strategyPlan: string[];
};

const BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.7-highspeed";
const DEFAULT_INDUSTRY: ExpertIndustry = "其他";
const LOG_FILE = path.join(process.cwd(), "data", "chat-logs.ndjson");

async function logChatEvent(record: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(path.dirname(LOG_FILE), { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
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

function createFallbackReplyStream(reply: string, stage: string) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({ type: "delta", content: sanitizeModelText(reply) })}\n`
        )
      );
      controller.enqueue(
        encoder.encode(`${JSON.stringify({ type: "done", stage })}\n`)
      );
      controller.close();
    },
  });
}

async function createMiniMaxReplyStream(
  messages: ChatMessage[],
  industry: ExpertIndustry,
  fastTrack: boolean,
  stage: string,
  toolContext: string
): Promise<ReadableStream<Uint8Array>> {
  const key = process.env.MINIMAX_API_KEY;
  const userTurnCount = messages.filter((m) => m.role === "user").length;

  if (!key) {
    return createFallbackReplyStream(
      fallbackReply(messages, industry, fastTrack),
      stage
    );
  }

  const modelMessages = [
    {
      role: "system",
      content:
        buildInterviewSystemPrompt(industry, userTurnCount, fastTrack) +
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
      stage
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
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
          encoder.encode(`${JSON.stringify({ type: "done", stage })}\n`)
        );
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
  toolContext: string
): Promise<string | null> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return null;

  const userTurnCount = messages.filter((m) => m.role === "user").length;

  const modelMessages = [
    {
      role: "system",
      content:
        buildInterviewSystemPrompt(industry, userTurnCount, fastTrack) +
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

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as DistillPayload;
    if (!validateMessages(payload.messages)) {
      return NextResponse.json(
        { error: "无效输入，请检查对话内容。" },
        { status: 400 }
      );
    }

    const mode = payload.mode || "reply";
    const messages = payload.messages;
    const industry = resolveIndustry(payload.industry);
    const fastTrack = Boolean(payload.fastTrack);
    const stream = Boolean(payload.stream);
    const toolContext = normalizeToolContext(payload.toolContext);
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId
      ? payload.sessionId
      : randomUUID();

    if (mode === "reply") {
      const userTurns = messages.filter((m) => m.role === "user").length;
      const stage = getReplyStage(userTurns, fastTrack);

      if (stream) {
        const replyStream = await createMiniMaxReplyStream(
          messages,
          industry,
          fastTrack,
          stage,
          toolContext
        );

        // Log the latest user turn (fire-and-forget)
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        if (lastUserMsg) {
          void logChatEvent({
            event: "turn",
            ts: new Date().toISOString(),
            sessionId,
            industry,
            fastTrack,
            userTurnCount: userTurns,
            userMessage: lastUserMsg.content,
          });
        }

        return new Response(replyStream, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
          },
        });
      }

      const assistantReply =
        (await callMiniMaxForReply(messages, industry, fastTrack, toolContext)) ??
        fallbackReply(messages, industry, fastTrack);
      return NextResponse.json({
        assistantReply,
        stage,
      });
    }

    const reportFromModel = await callMiniMaxForReport(
      messages,
      industry,
      toolContext
    );
    const answers = reportFromModel?.answers ?? deriveAnswersFromMessages(messages);
    const report = reportFromModel?.report ?? fallbackDistill(answers);
    const score = calculateScore(answers);

    console.log("[distill/report] answers:", JSON.stringify(answers));
    console.log("[distill/report] score:", JSON.stringify(score));
    console.log("[distill/report] modelUsed:", reportFromModel ? "LLM" : "fallback");

    // Log full session on report generation (fire-and-forget)
    void logChatEvent({
      event: "report",
      ts: new Date().toISOString(),
      sessionId,
      industry,
      fastTrack,
      userTurnCount: messages.filter((m) => m.role === "user").length,
      messages,
      answers,
      score,
      distillation: report,
    });

    return NextResponse.json({ distillation: report, score, answers });
  } catch (err) {
    console.error("[distill] unexpected error:", err);
    return NextResponse.json(
      { error: "分析失败，请稍后重试。" },
      { status: 500 }
    );
  }
}