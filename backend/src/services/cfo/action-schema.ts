import { z } from "zod";

export const usdcAmount = z.string()
  .regex(/^\d+(\.\d{1,6})?$/, "Amount must be a positive USDC decimal with at most 6 decimals.")
  .refine((value) => /[1-9]/.test(value), "Amount must be greater than zero.");

/** The complete, closed set of treasury changes a CFO plan may request. */
export const actionSchema = z.union([
  z.object({ type: z.literal("allocate"), allocations: z.array(z.object({ vaultId: z.number().int().nonnegative(), amount: usdcAmount })).min(1).max(12) }),
  z.object({ type: z.literal("propose_withdrawal"), vaultId: z.number().int().nonnegative(), recipient: z.string().min(1), amount: usdcAmount }),
  z.object({
    type: z.literal("propose_scheduled_transfer"), sourceVaultId: z.number().int().nonnegative(),
    destinationVaultId: z.number().int().nonnegative().optional(), recipient: z.string().min(1).optional(),
    amount: usdcAmount, intervalSeconds: z.number().int().positive(), firstExecutionAt: z.number().int().positive(),
  }).superRefine((value, context) => {
    if ((value.destinationVaultId === undefined) === (value.recipient === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose exactly one destination: a vault or an external recipient." });
    }
  }),
]);

export const planSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  actions: z.array(actionSchema).min(1).max(12),
  requiredApprovals: z.number().int().min(1).max(10),
});

export type CfoAction = z.infer<typeof actionSchema>;
export type CfoPlan = z.infer<typeof planSchema>;
