import { z } from "zod";

export const ipCardPreset = z.strictObject({
  layout: z.enum(["leftVisualRightText", "rightVisualLeftText"]),
  paper: z.enum(["warmWhite", "coolWhite"]),
  accent: z.enum(["blue", "green"]),
  showPage: z.boolean(),
});

export type IpCardPreset = z.infer<typeof ipCardPreset>;
