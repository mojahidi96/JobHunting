import { z } from "zod";
import { ApiError } from "../errors.js";

const template = z.object({
  subject: z.string().trim().min(1, "subject must not be empty").max(300),
  html: z.string().trim().min(1, "html must not be empty").max(100_000),
});
const ids = z.array(z.string().regex(/^row-\d+$/, "invalid recruiter id")).min(1).max(500);

export const previewSchema = z.object({ recruiterIds: ids, template });
export const sendSchema = z.object({
  recruiterIds: ids,
  template,
  options: z
    .object({
      delayMinMs: z.number().finite().optional(),
      delayMaxMs: z.number().finite().optional(),
      skipRowsMarkedNo: z.boolean().optional(),
    })
    .optional(),
  confirmation: z.unknown().optional(),
});

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "The request is invalid.", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`));
  }
  return r.data;
}
