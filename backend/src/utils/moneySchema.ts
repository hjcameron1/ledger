import { z } from 'zod';

// L2 (stress audit): a figure beyond IEEE-754 safe-integer range silently loses
// precision (9,007,199,254,740,993 stores as …992) and then corrupts every
// total it enters. No real balance reaches this; reject it at the schema so a
// fat-finger or a bad import fails loudly instead of quietly.
export const MAX_MONEY = Number.MAX_SAFE_INTEGER;

// Stays a ZodNumber (gte/lte, not refine) so routes can keep chaining
// .nonnegative() / .int() / .nullable() on top.
export const money = z.number().finite().gte(-MAX_MONEY).lte(MAX_MONEY);
