export type AssessmentAnswers = {
  industryDepth: number;
  problemDefinition: number;
  crossDomainSynthesis: number;
  orgMomentum: number;
  aiCollaboration: number;
  methodologyTransferability: number;
  uniqueCase: string;
  antiCase: string;
  next90DaysPlan: string;
};

export type ScoreTier = "Entry" | "Growing" | "Advanced" | "Pioneer";

export type ScoreBreakdown = {
  total: number;
  tier: ScoreTier;
  dimensions: {
    industryDepth: number;
    problemDefinition: number;
    crossDomainSynthesis: number;
    orgMomentum: number;
    aiCollaboration: number;
    methodologyTransferability: number;
  };
};

const WEIGHTS = {
  industryDepth: 0.2,
  problemDefinition: 0.15,
  crossDomainSynthesis: 0.18,
  orgMomentum: 0.15,
  aiCollaboration: 0.17,
  methodologyTransferability: 0.15,
};

function scaleOneToFiveToHundred(value: number): number {
  const clamped = Math.min(5, Math.max(1, value));
  // 1→10, 2→35, 3→60, 4→80, 5→100
  // Avoids cliff-edge zero at score=1 while keeping meaningful spread
  const table: Record<number, number> = { 1: 10, 2: 35, 3: 60, 4: 80, 5: 100 };
  return table[clamped] ?? Math.round(((clamped - 1) / 4) * 100);
}

function textBonus(content: string, cap: number): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  const richLength = Math.min(trimmed.length, 480);
  return Math.min(cap, Math.round(richLength / 40));
}

function resolveTier(total: number): ScoreTier {
  if (total <= 38) return "Entry";
  if (total <= 58) return "Growing";
  if (total <= 78) return "Advanced";
  return "Pioneer";
}

export function calculateScore(answers: AssessmentAnswers): ScoreBreakdown {
  const dimensions = {
    industryDepth: Math.min(
      100,
      scaleOneToFiveToHundred(answers.industryDepth) + textBonus(answers.uniqueCase, 8)
    ),
    problemDefinition: Math.min(
      100,
      scaleOneToFiveToHundred(answers.problemDefinition) + textBonus(answers.antiCase, 10)
    ),
    crossDomainSynthesis: scaleOneToFiveToHundred(answers.crossDomainSynthesis),
    orgMomentum: scaleOneToFiveToHundred(answers.orgMomentum),
    aiCollaboration: Math.min(
      100,
      scaleOneToFiveToHundred(answers.aiCollaboration) + textBonus(answers.next90DaysPlan, 10)
    ),
    methodologyTransferability: scaleOneToFiveToHundred(
      answers.methodologyTransferability
    ),
  };

  const total = Math.round(
    dimensions.industryDepth * WEIGHTS.industryDepth +
      dimensions.problemDefinition * WEIGHTS.problemDefinition +
      dimensions.crossDomainSynthesis * WEIGHTS.crossDomainSynthesis +
      dimensions.orgMomentum * WEIGHTS.orgMomentum +
      dimensions.aiCollaboration * WEIGHTS.aiCollaboration +
      dimensions.methodologyTransferability * WEIGHTS.methodologyTransferability
  );

  return {
    total,
    tier: resolveTier(total),
    dimensions,
  };
}

export function tierNarrative(tier: ScoreTier): {
  title: string;
  risk: string;
  actions: string[];
} {
  const table: Record<ScoreTier, { title: string; risk: string; actions: string[] }> = {
    Entry: {
      title: "起步型：你有专业基础，但尚未形成 AI 协同闭环",
      risk: "如果只停留在工具试用，容易被具备方法论的同业拉开差距。",
      actions: [
        "选一个高价值场景，7 天内完成可复用流程文档。",
        "为每个判断结论写出证据来源，强化可解释性。",
        "建立每周 1 次的 AI 复盘机制，避免随机探索。",
      ],
    },
    Growing: {
      title: "增长型：你正在形成 AI 时代的稳定竞争力",
      risk: "能力增长快，但若没有迁移方法，扩张会卡在个人产能。",
      actions: [
        "把 1 个成功案例拆成模板，供团队复用。",
        "将提炼出的关键变量加入你的项目复盘表。",
        "定义 90 天内可量化的效率指标并周度跟踪。",
      ],
    },
    Advanced: {
      title: "进阶型：你已具备明显的差异化与放大潜力",
      risk: "优势明确，但若不产品化，价值释放速度会受限。",
      actions: [
        "把高频交付步骤沉淀成固定交付件和提示链路。",
        "为不同客户类型建立 2 套差异化分析脚本。",
        "开始构建可对外传播的行业洞察内容。",
      ],
    },
    Pioneer: {
      title: "先锋型：你已处于 AI 协同专家的领先梯队",
      risk: "领先优势需要通过组织化复制，否则很难形成规模壁垒。",
      actions: [
        "建立知识资产库，固化你的判断框架与例外处理规则。",
        "设计团队协同机制，让他人能在你框架下稳定交付。",
        "围绕方法论推出标准化服务，扩展影响力半径。",
      ],
    },
  };

  return table[tier];
}