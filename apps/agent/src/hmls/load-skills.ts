// On-demand skill loader for the `load_skill` tool. `.skills/<name>/skill.md`
// files are the canonical home for domain knowledge (state machines, pricing
// reference tables, decision frameworks). The agent pulls a skill's body into
// the conversation when it enters that area, instead of inlining everything at
// boot. `readSkillBody` strips the YAML frontmatter (metadata for skill
// selection, not for the model's reasoning) and returns the body.

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
