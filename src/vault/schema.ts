import { z } from "zod";

export const frontmatterSchema = z
  .object({
    type: z.string().optional(),
    category: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: z.string().optional(),
    source: z.string().optional(),
    created: z.string().optional(),
    tags: z.array(z.string()).optional(),
    todoist_id: z.string().optional(),
  })
  .passthrough();
