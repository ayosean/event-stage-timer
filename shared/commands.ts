import { z } from "zod";
import { MAX_MS } from "./timer.js";
const duration = z.number().int().min(1000).max(MAX_MS);
const id = z.string().uuid();
const name = z.string().trim().min(1).max(120);
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("reset") }),
  z.object({ type: z.literal("setDuration"), durationMs: duration }),
  z.object({
    type: z.literal("adjust"),
    deltaMs: z.union([
      z.literal(60000),
      z.literal(300000),
      z.literal(600000),
      z.literal(-60000),
      z.literal(-300000),
      z.literal(-600000),
    ]),
  }),
  z.object({ type: z.literal("select"), id }),
  z.object({
    type: z.literal("step"),
    direction: z.union([z.literal(1), z.literal(-1)]),
  }),
  z.object({ type: z.literal("add"), name, durationMs: duration }),
  z.object({ type: z.literal("update"), id, name, durationMs: duration }),
  z.object({ type: z.literal("duplicate"), id }),
  z.object({ type: z.literal("delete"), id }),
  z.object({
    type: z.literal("move"),
    id,
    direction: z.union([z.literal(1), z.literal(-1)]),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
