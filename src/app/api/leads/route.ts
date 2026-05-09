import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

type LeadPayload = {
  name?: string;
  email?: string;
  wechat?: string;
  industry?: string;
  score?: number;
  tier?: string;
  dimensions?: Record<string, number>;
  consent?: boolean;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "leads.json");

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function appendLead(lead: Record<string, unknown>) {
  await mkdir(DATA_DIR, { recursive: true });

  let current: Array<Record<string, unknown>> = [];
  try {
    const content = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(content) as Array<Record<string, unknown>>;
    if (Array.isArray(parsed)) {
      current = parsed;
    }
  } catch {
    current = [];
  }

  current.push(lead);
  await writeFile(DATA_FILE, JSON.stringify(current, null, 2), "utf8");
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as LeadPayload;
    const name = (payload.name ?? "").trim();
    const email = (payload.email ?? "").trim();
    const wechat = (payload.wechat ?? "").trim();
    const industry = (payload.industry ?? "").trim();

    if (!name) {
      return NextResponse.json({ error: "姓名不能为空。" }, { status: 400 });
    }
    if (!email || !validEmail(email)) {
      return NextResponse.json(
        { error: "请输入有效邮箱。" },
        { status: 400 }
      );
    }
    if (!industry) {
      return NextResponse.json({ error: "请选择行业。" }, { status: 400 });
    }
    if (!payload.consent) {
      return NextResponse.json(
        { error: "请先同意后续联系。" },
        { status: 400 }
      );
    }

    const leadId = randomUUID();
    const lead = {
      id: leadId,
      createdAt: new Date().toISOString(),
      name,
      email,
      wechat,
      industry,
      score: payload.score,
      tier: payload.tier,
      dimensions: payload.dimensions,
      consent: true,
    };

    await appendLead(lead);

    return NextResponse.json({ ok: true, leadId });
  } catch {
    return NextResponse.json(
      { error: "留资失败，请稍后重试。" },
      { status: 500 }
    );
  }
}