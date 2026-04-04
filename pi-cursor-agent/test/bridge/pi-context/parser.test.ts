import assert from "node:assert/strict";
import test from "node:test";
import { parsePiSystemPrompt } from "../../../src/bridge/pi-context/parser";

const PI_DOCS_BLOCK = [
  "Pi documentation (read only when the user asks about pi itself):",
  "- Main documentation: /path/to/pi-0.64.0/lib/pi/README.md",
  "- Additional docs: /path/to/pi-0.64.0/lib/pi/docs",
].join("\n");

function buildPrompt(
  opts: {
    contextFiles?: { path: string; content: string }[];
    skills?: { name: string; description: string; location: string }[];
    contextDescription?: string;
    skillsIntro?: string;
    piDocs?: boolean;
  } = {},
): string {
  let p =
    "You are an expert coding assistant.\n\nAvailable tools:\n- read\n- bash";

  if (opts.piDocs) p += `\n\n${PI_DOCS_BLOCK}`;

  if (opts.contextFiles?.length) {
    const desc =
      opts.contextDescription ??
      "Project-specific instructions and guidelines:";
    p += `\n\n# Project Context\n\n${desc}\n\n`;
    for (const f of opts.contextFiles) p += `## ${f.path}\n\n${f.content}\n\n`;
  }

  if (opts.skills?.length) {
    const intro =
      opts.skillsIntro ??
      "The following skills provide specialized instructions.";
    p += `\n${intro}\n\n<available_skills>`;
    for (const s of opts.skills) {
      p += `\n  <skill><name>${s.name}</name><description>${s.description}</description><location>${s.location}</location></skill>`;
    }
    p += "\n</available_skills>";
  }

  p += "\nCurrent date: 2026-03-30";
  p += "\nCurrent working directory: /test/project";
  return p;
}

test("extracts context files and skills", () => {
  const result = parsePiSystemPrompt(
    buildPrompt({
      contextFiles: [
        { path: "/global/AGENTS.md", content: "Global rules." },
        { path: "/project/AGENTS.md", content: "Project rules." },
      ],
      skills: [
        {
          name: "react",
          description: "React guide.",
          location: "/skills/react/SKILL.md",
        },
      ],
    }),
  );

  assert.equal(result.contextFiles.length, 2);
  assert.equal(result.contextFiles[0]?.path, "/global/AGENTS.md");
  assert.ok(result.contextFiles[0]?.content.includes("Global rules."));
  assert.equal(result.contextFiles[1]?.path, "/project/AGENTS.md");
  assert.ok(result.contextFiles[1]?.content.includes("Project rules."));
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]?.name, "react");
});

test("cleanedPrompt keeps metadata and Pi documentation", () => {
  const result = parsePiSystemPrompt(
    buildPrompt({
      contextFiles: [{ path: "/AGENTS.md", content: "x" }],
      piDocs: true,
    }),
  );

  assert.ok(result.cleanedPrompt.includes("Current date:"));
  assert.ok(result.cleanedPrompt.includes("Current working directory:"));
  assert.ok(result.cleanedPrompt.includes("Pi documentation"));
  assert.ok(result.cleanedPrompt.includes("- Main documentation:"));
  assert.ok(!result.cleanedPrompt.includes("Available tools:"));
});

test("returns empty for prompt without context or skills", () => {
  const result = parsePiSystemPrompt(buildPrompt());
  assert.deepEqual(result.contextFiles, []);
  assert.deepEqual(result.skills, []);
});

test("resilient to changed description and intro text", () => {
  const result = parsePiSystemPrompt(
    buildPrompt({
      contextFiles: [{ path: "/AGENTS.md", content: "Still works." }],
      skills: [{ name: "s", description: "d", location: "/SKILL.md" }],
      contextDescription: "Completely rewritten description in future Pi:",
      skillsIntro: "Totally different skills intro paragraph.",
    }),
  );

  assert.equal(result.contextFiles.length, 1);
  assert.ok(result.contextFiles[0]?.content.includes("Still works."));
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]?.name, "s");
});

test("ignores non-path ## headings inside context file content", () => {
  const result = parsePiSystemPrompt(
    buildPrompt({
      contextFiles: [
        {
          path: "/project/AGENTS.md",
          content: "Instructions\n\n## Commands\n\nRun tests.",
        },
      ],
    }),
  );

  assert.equal(result.contextFiles.length, 1);
  assert.equal(result.contextFiles[0]?.path, "/project/AGENTS.md");
  assert.ok(result.contextFiles[0]?.content.includes("## Commands"));
  assert.ok(result.contextFiles[0]?.content.includes("Run tests."));
});

test("unescapes XML entities in skill data", () => {
  const result = parsePiSystemPrompt(
    buildPrompt({
      skills: [
        {
          name: "t",
          description: "&lt;html&gt; &amp; &quot;q&quot;",
          location: "/SKILL.md",
        },
      ],
    }),
  );

  assert.equal(result.skills[0]?.description, '<html> & "q"');
});
