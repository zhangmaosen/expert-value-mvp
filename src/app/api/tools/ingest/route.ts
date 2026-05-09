import { NextResponse } from "next/server";

type IngestPayload = {
  htmlUrl?: string;
  documentContent?: string;
};

const MAX_CONTEXT_CHARS = 12000;

function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripHtml(html: string): string {
  return normalizeText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s{2,}/g, " ")
  );
}

function cutContent(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[内容过长，已截断]`;
}

function parseTitle(html: string): string {
  const matched = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!matched?.[1]) return "网页资料";
  return normalizeText(matched[1]).slice(0, 120) || "网页资料";
}

function resolveUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as IngestPayload;

    const hasUrl = typeof payload.htmlUrl === "string" && payload.htmlUrl.trim().length > 0;
    const hasContent =
      typeof payload.documentContent === "string" &&
      payload.documentContent.trim().length > 0;

    if (!hasUrl && !hasContent) {
      return NextResponse.json(
        { error: "请提供 HTML 地址或文档内容。" },
        { status: 400 }
      );
    }

    if (hasUrl) {
      const parsedUrl = resolveUrl(payload.htmlUrl!);
      if (!parsedUrl) {
        return NextResponse.json(
          { error: "无效链接，请输入以 http/https 开头的地址。" },
          { status: 400 }
        );
      }

      const response = await fetch(parsedUrl, {
        headers: {
          "User-Agent": "ExpertValueMVP/1.0 (+tool-ingest)",
        },
      });

      if (!response.ok) {
        return NextResponse.json(
          { error: "抓取网页失败，请检查链接是否可访问。" },
          { status: 400 }
        );
      }

      const html = await response.text();
      const title = parseTitle(html);
      const content = cutContent(stripHtml(html));

      if (!content) {
        return NextResponse.json(
          { error: "未提取到可用文本，请尝试粘贴文档内容。" },
          { status: 400 }
        );
      }

      return NextResponse.json({
        sourceType: "url",
        title,
        content,
        chars: content.length,
      });
    }

    const normalized = cutContent(normalizeText(payload.documentContent!));
    if (!normalized) {
      return NextResponse.json(
        { error: "文档内容为空，请补充后重试。" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      sourceType: "document",
      title: "手动上传文档",
      content: normalized,
      chars: normalized.length,
    });
  } catch {
    return NextResponse.json(
      { error: "工具处理失败，请稍后重试。" },
      { status: 500 }
    );
  }
}
