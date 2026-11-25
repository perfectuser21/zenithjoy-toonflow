import { z } from "zod";

export const ipCardPreset = z.strictObject({
  layout: z.enum(["leftVisualRightText", "rightVisualLeftText"]),
  paper: z.enum(["dark", "warmWhite", "coolWhite"]),
  accent: z.enum(["purple", "blue", "green"]),
  showPage: z.boolean(),
});
export type IpCardPreset = z.infer<typeof ipCardPreset>;

const text = (limit: number) => z.string().trim().max(limit);
export const ipCardCopy = z.strictObject({
  title: text(42).min(1),
  brand: text(32),
  focus: text(30),
  caption: text(60),
  items: z.array(z.strictObject({ label: text(14), text: text(86) })).max(4),
});
export type IpCardCopy = z.infer<typeof ipCardCopy>;

export const ipCardNumber = z.number().int().min(1).max(5);
export const defaultPreset: IpCardPreset = {
  layout: "leftVisualRightText",
  paper: "dark",
  accent: "purple",
  showPage: true,
};

export const ipCardProposal = z.strictObject({
  style: ipCardPreset.partial().optional(),
  cards: z.array(z.strictObject({ number: ipCardNumber, copy: ipCardCopy.partial() })).max(5).optional(),
});
