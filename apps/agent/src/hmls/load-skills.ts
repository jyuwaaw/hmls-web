// Inline-load skill markdown into the agent's system prompt at boot.
// `.skills/<name>/skill.md` files are the canonical home for domain
// knowledge (state machines, pricing reference tables, decision frameworks).
// Without this loader they would be developer-only docs that the model
// never actually sees.
//
// Usage:
//   const skills = await loadSkills(["scheduling", "order"]);
//   const fullPrompt = `${SYSTEM_PROMPT}\n\n${skills}`;
//
// The loader strips the YAML frontmatter (which is metadata for the
// `Skill` tool's selection UI, not for the model's reasoning) and
// concatenates the bodies under a `# Skills` heading.

const SKILLS_DIR = new URL("../../.skills/", import.meta.url);

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\n+/, "");
}

/** Skills the agents may pull on demand via the `load_skill` tool. v1 = the two
 *  heavy bodies that used to be inlined at boot. Diagnosis skills stay Fixo-only. */
export const LOADABLE_SKILLS = ["order", "scheduling"] as const;
export type LoadableSkill = (typeof LOADABLE_SKILLS)[number];

/** Read one skill's body (frontmatter stripped). null if missing or empty. */
export async function readSkillBody(name: string): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(new URL(`${name}/skill.md`, SKILLS_DIR));
    const body = stripFrontmatter(raw).trim();
    return body || null;
  } catch {
    return null;
  }
}

/** Read the named skills' bodies and return a single concatenated string
 *  ready to drop after the static system prompt. Skills are emitted in
 *  the order requested. Missing files are skipped silently — adding a
 *  skill name without a backing file should be a soft failure, not a
 *  startup crash. */
export async function loadSkills(names: readonly string[]): Promise<string> {
  const sections: string[] = [];
  for (const name of names) {
    try {
      const url = new URL(`${name}/skill.md`, SKILLS_DIR);
      const raw = await Deno.readTextFile(url);
      const body = stripFrontmatter(raw).trim();
      if (body) sections.push(body);
    } catch (_err) {
      // Skip missing/unreadable skills.
    }
  }
  if (sections.length === 0) return "";
  return `# Skills\n\n${sections.join("\n\n---\n\n")}`;
}
