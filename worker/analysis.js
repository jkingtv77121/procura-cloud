const STOP = new Set("a an and are as at be been being by can could did do does for from had has have how i in into is it its may might must of on or our shall should that the their then there these this to us was were will with within you your provide provides".split(" "));
const GROUPS = [
  ["uptime", "availability", "service level", "sla"],
  ["security", "secure", "encryption", "encrypted", "data protection"],
  ["experience", "years", "track record", "case study"],
  ["references", "reference", "client", "customer"],
  ["support", "helpdesk", "service desk", "24 7"],
  ["go live", "implementation", "deployment", "delivery", "timeline"],
  ["budget", "pricing", "price", "cost", "fees"],
  ["users", "students", "concurrent", "capacity", "scale"],
  ["integrate", "integration", "compatible", "connect"],
  ["accessibility", "wcag", "ada"],
  ["training", "enablement", "documentation"],
];

function normalize(value) {
  return String(value || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9$%]+/g, " ").trim();
}

function tokens(value) {
  return normalize(value).split(/\s+/).filter((item) => item && (!STOP.has(item) || /^\d/.test(item)) && item.length > 1);
}

function splitCandidateLine(line) {
  const text = line.replace(/^\s*(?:\d+[\).]|[-*•●▪])\s*/, "").trim();
  if (!text) return [];
  const labeled = text.match(/^(?:requirements?|scope|minimum requirements|mandatory requirements|technical requirements|commercial requirements)\s*:\s*(.*)$/i);
  const mandatoryLabel = /^mandatory requirements?:/i.test(text);
  const body = labeled ? labeled[1] : text;
  const pieces = body
    .replace(/\s*[•●▪]\s*/g, "\n")
    .split(/\s*;\s*|\n+/)
    .flatMap((part) => labeled ? part.split(/,\s+(?=[A-Za-z0-9])/g) : [part])
    .flatMap((part) => !labeled && part.length > 55 ? part.split(/,\s+(?=(?:at least|minimum|within|no more than|not exceed|must|shall|the vendor|the platform|the system|provide|support|ISO\b|SOC\s*2\b|HIPAA\b|GDPR\b|FedRAMP\b|99(?:\.\d+)?%|24\/7|\d+\+?\s+years?|go-?live\b|budget\b|pricing\b|local office\b))/i) : [part])
    .flatMap((part) => part.length > 280 ? part.split(/,\s+(?=[A-Z0-9]|(?:at least|minimum|within|no more than|must|shall|the vendor|the system)\b)/i) : [part])
    .flatMap((part) => part.length > 330 ? part.split(/(?<=[.!?])\s+(?=[A-Z])/g) : [part]);
  return pieces.map((part) => (mandatoryLabel ? "Mandatory requirement: " : "") + part.replace(/^(?:and|also)\s+/i, "").trim()).filter(Boolean);
}

function categoryFor(text) {
  if (/budget|price|pricing|cost|fee|payment|commercial|invoice/i.test(text)) return "Commercial";
  if (/iso|soc\s*2|hipaa|gdpr|compliance|certif|privacy|encryption|security|data residenc/i.test(text)) return "Compliance";
  if (/reference|experience|years|company background|past performance|case stud/i.test(text)) return "Experience";
  if (/support|uptime|availability|sla|service level|training|staff|personnel|timeline|days|go.live|capacity|integrat|platform|system|user|student/i.test(text)) return "Technical";
  return "Delivery";
}

function isHardGate(text) {
  return /\b(must|shall|required|mandatory|minimum|at least|no less than|no more than|not exceed|within|is a condition of|will be disqualified)\b/i.test(text)
    || /\b(iso\s*27001|soc\s*2|hipaa|fedramp|certification|certified|compliance)\b/i.test(text);
}

export function extractRequirements(rfpText) {
  const lines = String(rfpText || "").replace(/\r/g, "\n").split(/\n+/);
  const candidates = lines.flatMap(splitCandidateLine);
  const seen = new Set();
  const requirements = [];
  for (const text of candidates) {
    if (text.length < 14 || text.length > 420) continue;
    if (!/\b(must|shall|required|mandatory|minimum|at least|no less than|no more than|not exceed|within|provide|support|include|maintain|achieve|deliver|deploy|integrat|compatible|compliant|compliance|certif|experience|uptime|availability|budget|price|cost|security|encrypt|reference|capacity|accessibility|training|staff|timeline|go.live|service level|sla|users?|students?|days|years|2|3|4|5|6|7|8|9|10|99(?:\.\d+)?%)\b/i.test(text)) continue;
    const key = normalize(text).replace(/\b(the|a|an|must|shall|required)\b/g, "").trim();
    if (key.length < 10 || seen.has(key)) continue;
    seen.add(key);
    const mandatory = /^mandatory requirement:/i.test(text) || isHardGate(text);
    const category = categoryFor(text);
    const weight = mandatory ? 2 : category === "Commercial" ? 1.35 : 1;
    requirements.push({
      id: "req-" + (requirements.length + 1),
      title: text.replace(/^mandatory requirement:\s*/i, "").replace(/^(?:requirements?|scope)\s*:\s*/i, "").replace(/[.]+$/, ""),
      category,
      is_hard_gate: mandatory,
      weight,
      rfp_quote: text.replace(/^mandatory requirement:\s*/i, "").trim(),
    });
    if (requirements.length >= 36) break;
  }
  if (!requirements.length) {
    throw new Error("Procura could not identify requirement statements in this RFP. Add a requirements list or clear sentences describing what you need.");
  }
  return requirements;
}

function groupFor(term) {
  for (const group of GROUPS) if (group.some((word) => normalize(word).split(" ").includes(term) || normalize(word).includes(term))) return group;
  return [term];
}

function proposalSentences(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])|;\s+/)
    .map((item) => item.trim().replace(/^[-*•●▪\d.)\s]+/, ""))
    .filter((item) => item.length >= 12);
}

function quoteMatch(requirement, proposalText) {
  const requiredTokens = [...new Set(tokens(requirement.title))];
  const sentences = proposalSentences(proposalText);
  let best = null;
  for (const sentence of sentences) {
    const responseTokens = new Set(tokens(sentence));
    const matched = requiredTokens.filter((term) => groupFor(term).some((candidate) => tokens(candidate).some((candidateToken) => responseTokens.has(candidateToken))));
    const core = requiredTokens.length ? matched.length / requiredTokens.length : 0;
    const candidate = { sentence, matched, ratio: core };
    if (!best || candidate.ratio > best.ratio) best = candidate;
  }
  return { requiredTokens, best };
}

function numericMismatch(requirement, quote) {
  const requirementText = requirement.title.toLowerCase();
  const quoteText = String(quote || "").toLowerCase();
  const reqYears = requirementText.match(/(?:at least|minimum of|min\.?)?\s*(\d+(?:\.\d+)?)\s*\+?\s*years?/i);
  const responseYears = quoteText.match(/(\d+(?:\.\d+)?)\s*\+?\s*years?/i);
  if (reqYears && responseYears && Number(responseYears[1]) < Number(reqYears[1])) return true;
  const reqPercent = requirementText.match(/(\d+(?:\.\d+)?)\s*%/);
  const responsePercent = quoteText.match(/(\d+(?:\.\d+)?)\s*%/);
  if (reqPercent && responsePercent && /(?:at least|minimum|no less|greater than|above|over|uptime|availability)/i.test(requirementText) && Number(responsePercent[1]) < Number(reqPercent[1])) return true;
  const reqDays = requirementText.match(/(?:within|no more than|at most|maximum of|max\.?)\s*(\d+(?:\.\d+)?)\s*days?/i);
  const responseDays = quoteText.match(/(\d+(?:\.\d+)?)\s*days?/i);
  if (reqDays && responseDays && Number(responseDays[1]) > Number(reqDays[1])) return true;

  const reqCapacity = requirementText.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:(?:active|concurrent|licensed|registered)\s+)*(?:users|students|seats|licenses|accounts)\b/i);
  const responseCapacity = quoteText.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:(?:active|concurrent|licensed|registered)\s+)*(?:users|students|seats|licenses|accounts)\b/i);
  if (reqCapacity && responseCapacity && Number(responseCapacity[1].replace(/,/g, "")) < Number(reqCapacity[1].replace(/,/g, ""))) return true;

  const moneyAmount = (text) => {
    const match = text.match(/(?:\$|\bUSD\s*)(\d[\d,]*(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\b/i);
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ""));
    const multiplier = /^(?:k|thousand)$/i.test(match[2] || "") ? 1000
      : /^(?:m|million)$/i.test(match[2] || "") ? 1000000
      : /^(?:b|billion)$/i.test(match[2] || "") ? 1000000000
      : 1;
    return amount * multiplier;
  };
  const maxBudget = /budget|price|pricing|cost|fee/i.test(requirementText)
    && /within|no more than|at most|maximum|max\.?|not exceed|under|below|up to/i.test(requirementText);
  if (maxBudget) {
    const limit = moneyAmount(requirementText);
    const proposed = moneyAmount(quoteText);
    if (limit !== null && proposed !== null && proposed > limit) return true;
  }
  return false;
}

function explicitlyDenied(requirement, quote) {
  const haystack = normalize(quote);
  const terms = [...new Set(tokens(requirement.title).flatMap(groupFor))].filter((term) => term.length > 2);
  for (const term of terms) {
    const normalizedTerm = normalize(term);
    if (!normalizedTerm || !haystack.includes(normalizedTerm)) continue;
    const index = haystack.indexOf(normalizedTerm);
    const nearby = haystack.slice(Math.max(0, index - 48), index + normalizedTerm.length + 5);
    if (/\b(no|not|never|without|cannot|unable|failed|do not|does not|doesnt|dont|not yet)\b/.test(nearby)) return true;
  }
  return false;
}

export function analyzeVendor(rfpText, proposalText, vendorName, overrides = {}) {
  const requirements = extractRequirements(rfpText);
  let earned = 0;
  let total = 0;
  let hardGatesFailed = 0;
  const rows = requirements.map((requirement) => {
    const { requiredTokens, best } = quoteMatch(requirement, proposalText);
    const overlap = best?.matched.length || 0;
    const enoughTerms = requiredTokens.length <= 2 ? overlap >= 1 : overlap >= 2;
    const denied = overlap > 0 && explicitlyDenied(requirement, best?.sentence);
    let status = overlap === 0 || denied ? "GAP" : enoughTerms && best.ratio >= 0.34 ? "VERIFIED" : "PARTIAL";
    if (status === "VERIFIED" && numericMismatch(requirement, best?.sentence)) status = "PARTIAL";
    const override = overrides[requirement.id];
    if (["VERIFIED", "PARTIAL", "GAP"].includes(override)) status = override;
    const points = status === "VERIFIED" ? 1 : status === "PARTIAL" ? 0.5 : 0;
    earned += points * requirement.weight;
    total += requirement.weight;
    if (requirement.is_hard_gate && status !== "VERIFIED") hardGatesFailed++;
    return {
      ...requirement,
      status,
      proposal_quote: overlap ? best.sentence.slice(0, 420) : "",
      matched_terms: best?.matched || [],
      explanation: denied
        ? "The proposal text indicates this requirement is not met."
        : overlap
        ? String(overlap) + " of " + String(requiredTokens.length) + " key terms appear in the response" + (numericMismatch(requirement, best?.sentence) ? "; the proposed figure does not meet the RFP threshold." : ".")
        : "No matching language was found in this proposal.",
      reviewer_override: ["VERIFIED", "PARTIAL", "GAP"].includes(override) ? override : null,
    };
  });
  const score = total ? Math.round(earned / total * 1000) / 10 : 0;
  const decision = hardGatesFailed ? "NO-BID" : score >= 75 ? "BID" : score >= 50 ? "BID WITH CONDITIONS" : "NO-BID";
  return {
    vendor_name: vendorName,
    score,
    decision,
    hard_gates_failed: hardGatesFailed,
    verified_count: rows.filter((row) => row.status === "VERIFIED").length,
    partial_count: rows.filter((row) => row.status === "PARTIAL").length,
    gap_count: rows.filter((row) => row.status === "GAP").length,
    total_count: rows.length,
    requirements: rows,
    method: "Deterministic text matching with source quotes. No win probability is inferred.",
  };
}

export function rankVendors(items) {
  return [...items]
    .sort((a, b) => a.hard_gates_failed - b.hard_gates_failed || b.score - a.score || a.vendor_name.localeCompare(b.vendor_name))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export const DEMO_CASE = {
  rfpName: "Mapleton Student Platform RFP.txt",
  rfpText: [
    "Mapleton University is seeking a student learning platform for 10,000 active students.",
    "Mandatory requirements: vendors must demonstrate at least 5 years of higher-education experience and provide SOC 2 Type II certification.",
    "The platform must support 10,000 concurrent users, 99.9% uptime, and WCAG 2.2 AA accessibility.",
    "Provide implementation and go-live within 120 days.",
    "Pricing must remain within a $2.5M total budget.",
  ].join("\n"),
  proposals: [
    {
      vendorName: "Northstar Learning",
      filename: "Northstar Learning - proposal.txt",
      text: [
        "Northstar Learning proposes a student learning platform for universities.",
        "We have 8 years of higher-education experience and attach our SOC 2 Type II certification.",
        "Our hosted service supports 12,000 concurrent users with 99.95% uptime. The product meets WCAG 2.2 AA accessibility.",
        "Implementation and go-live are planned in 105 days. Total pricing is $2.2M.",
      ].join("\n"),
    },
    {
      vendorName: "Pinecone Campus",
      filename: "Pinecone Campus - proposal.txt",
      text: [
        "Pinecone Campus supports student learning platforms for colleges.",
        "We have 3 years of higher-education experience and can support 7,000 concurrent users.",
        "The service reports 99.5% uptime. Accessibility work is in progress and is not yet certified.",
        "Go-live takes about 150 days. Total pricing is $2.1M.",
      ].join("\n"),
    },
    {
      vendorName: "Summit Education",
      filename: "Summit Education - proposal.txt",
      text: [
        "Summit Education is a learning platform serving universities.",
        "We have 9 years of higher-education experience but do not hold a SOC 2 Type II certification.",
        "The service supports 15,000 concurrent users and 99.99% uptime. We meet WCAG 2.2 AA accessibility.",
        "Implementation and go-live are planned in 90 days. Total pricing is $2.4M.",
      ].join("\n"),
    },
  ],
};
