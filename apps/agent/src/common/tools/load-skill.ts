import { z } from "zod";
import { toolResult } from "@hmls/shared/tool-result";
import { LOADABLE_SKILLS, readSkillBody } from "../../hmls/load-skills.ts";

export const loadSkillTool = {
  name: "load_skill",
  description:
    "Load a skill's full playbook into the conversation. Call this the MOMENT the chat enters " +
    "the skill's area, BEFORE acting — the skill body has the detailed pricing reference / state " +
    "machine that the base rules only summarize. The available skills are listed in your system " +
    "prompt's Skills index. A loaded skill stays available for the rest of the chat; don't reload it.",
  schema: z.object({
    name: z.enum(LOADABLE_SKILLS).describe("Which skill playbook to load"),
  }),
  execute: async (params: { name: (typeof LOADABLE_SKILLS)[number] }, _ctx: unknown) => {
    const body = await readSkillBody(params.name);
    if (!body) {
      return toolResult({ success: false, error: `Skill '${params.name}' not found` });
    }
    return toolResult({ success: true, skill: params.name, body });
  },
};

export const loadSkillTools = [loadSkillTool];
