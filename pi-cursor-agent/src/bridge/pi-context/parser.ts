/** Parse Pi system prompt into structured components for Cursor's RequestContext.rules. */

export interface PiContextFile {
  path: string;
  content: string;
}

export interface PiSkillRef {
  name: string;
  description: string;
  location: string;
}

export interface ParsedPiContext {
  contextFiles: PiContextFile[];
  skills: PiSkillRef[];
  cleanedPrompt: string;
}

// Stable structural markers only — no description text that may change across Pi versions.
const CONTEXT_HEADING = "# Project Context";
const SKILLS_OPEN = "<available_skills>";
const SKILLS_CLOSE = "</available_skills>";

const SKILL_RE =
  /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractContextFiles(prompt: string): PiContextFile[] {
  const start = prompt.indexOf(CONTEXT_HEADING);
  if (start === -1) return [];

  let end = prompt.length;
  for (const marker of [SKILLS_OPEN, "\nCurrent date: "]) {
    const idx = prompt.indexOf(marker, start);
    if (idx !== -1 && idx < end) end = idx;
  }

  return prompt
    .slice(start, end)
    .split(/^(?=## \/)/m)
    .slice(1)
    .flatMap((block) => {
      const nl = block.indexOf("\n");
      if (nl === -1) return [];
      const path = block.slice(3, nl).trim();
      const content = block.slice(nl + 1).trim();
      return path && content ? [{ path, content }] : [];
    });
}

function extractSkills(prompt: string): PiSkillRef[] {
  const openIdx = prompt.indexOf(SKILLS_OPEN);
  if (openIdx === -1) return [];

  const closeIdx = prompt.indexOf(SKILLS_CLOSE, openIdx);
  if (closeIdx === -1) return [];

  const xml = prompt.slice(openIdx, closeIdx + SKILLS_CLOSE.length);
  const skills: PiSkillRef[] = [];

  for (const m of xml.matchAll(SKILL_RE)) {
    if (!m[1] || !m[2] || !m[3]) continue;
    const name = unescapeXml(m[1].trim());
    const description = unescapeXml(m[2].trim());
    const location = unescapeXml(m[3].trim());
    if (name && description && location) {
      skills.push({ name, description, location });
    }
  }

  return skills;
}

const PRESERVED_PATTERNS = [
  /^Pi documentation[^\n]*(?:\n- [^\n]*)*/m,
  /^Current date: .+$/m,
  /^Current working directory: .+$/m,
];

function buildCleanedPrompt(original: string, hasExtracted: boolean): string {
  const lines = PRESERVED_PATTERNS.map((re) => original.match(re)?.[0]).filter(
    (s): s is string => s != null,
  );

  return lines.length === 0 && !hasExtracted ? original : lines.join("\n");
}

export function parsePiSystemPrompt(systemPrompt: string): ParsedPiContext {
  if (!systemPrompt) {
    return { contextFiles: [], skills: [], cleanedPrompt: "" };
  }

  try {
    const contextFiles = extractContextFiles(systemPrompt);
    const skills = extractSkills(systemPrompt);
    const hasExtracted = contextFiles.length > 0 || skills.length > 0;

    return {
      contextFiles,
      skills,
      cleanedPrompt: buildCleanedPrompt(systemPrompt, hasExtracted),
    };
  } catch {
    return { contextFiles: [], skills: [], cleanedPrompt: systemPrompt };
  }
}
