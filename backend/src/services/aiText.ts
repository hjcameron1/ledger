/**
 * ONE place that decides which model answers a small, JSON-shaped question —
 * and, crucially, keeps working when the other one isn't configured.
 *
 * Ledger has had two model providers wired up for a while, for different jobs:
 * Groq (`GROQ_API_KEY`, used by pdfParser for statement text) and Claude
 * (`CLAUDE_API_KEY`, used for document reading, Ask and classification). That was
 * fine until an environment had one key and not the other: the transaction
 * suggestions asked Claude, Claude wasn't configured there, and the button did
 * nothing but report a missing key. A key that isn't set in one deployment isn't
 * a reason for a feature to be dead — the other model can answer.
 *
 * So: a caller says what it wants asked and which provider it PREFERS, and this
 * module walks the configured providers in that order until one answers. If none
 * is configured, the error names both environment variables, because that is the
 * actual fix.
 *
 * Deliberately narrow — plain prompt in, raw text out. Parsing, validation and
 * every guarantee about the answer stay with the caller (`sanitizeAiClassifications`
 * is what makes a suggestion safe, not the model that produced it), so swapping
 * providers can't quietly widen what a model is trusted to do.
 */

import Anthropic from '@anthropic-ai/sdk';

export type AiProvider = 'groq' | 'claude';

/** Sonnet — the model every Claude-backed job in Ledger already used. */
export const CLAUDE_MODEL = 'claude-sonnet-4-5';
/**
 * 70B rather than 8b-instant for the same reason pdfParser picked it: the small
 * model mangles non-trivial JSON, and a mangled batch is a silent no-op here.
 */
export const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Lazy clients — created on first use so dotenv has already run by then.
let _anthropic: Anthropic | null = null;

/** The shared Anthropic client. Throws if `CLAUDE_API_KEY` isn't set. */
export function anthropic(): Anthropic {
  if (!_anthropic) {
    const key = process.env.CLAUDE_API_KEY;
    if (!key) throw new Error('CLAUDE_API_KEY is not set in environment');
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

/** Which providers this environment actually has a key for. */
export function configuredProviders(): AiProvider[] {
  const out: AiProvider[] = [];
  if (process.env.GROQ_API_KEY) out.push('groq');
  if (process.env.CLAUDE_API_KEY) out.push('claude');
  return out;
}

/**
 * PURE — the order to try, given a preference and what's configured. Preferred
 * providers first (in the order asked for), then anything else that's configured,
 * so a preference is a preference and never a restriction: a job that prefers
 * Groq still gets answered by Claude on a box that only has Claude.
 */
export function providerOrder(prefer: AiProvider[], available: AiProvider[]): AiProvider[] {
  const have = new Set(available);
  const order = prefer.filter(p => have.has(p));
  for (const p of available) if (!order.includes(p)) order.push(p);
  return order;
}

export interface CompleteTextOptions {
  prompt: string;
  maxTokens: number;
  /** Ask the provider for strict JSON where it supports a JSON mode. */
  json?: boolean;
  /** Preference order. Anything configured but unlisted is still used as a fallback. */
  prefer?: AiProvider[];
  /** Shown in logs so a fallback is visible in Render's output. */
  label?: string;
}

export interface AiCompletion {
  text: string;
  provider: AiProvider;
}

async function callGroq(opts: CompleteTextOptions): Promise<string> {
  const Groq = (await import('groq-sdk')).default;
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: opts.prompt }],
    temperature: 0,
    max_tokens: opts.maxTokens,
    ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
  });
  return completion.choices[0]?.message?.content ?? '';
}

async function callClaude(opts: CompleteTextOptions): Promise<string> {
  const response = await anthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: opts.maxTokens,
    messages: [{ role: 'user', content: opts.prompt }],
  });
  const block = response.content[0];
  return block && block.type === 'text' ? block.text : '';
}

/**
 * Ask the first available provider, falling through to the next on ANY failure
 * (missing key, rate limit, overload, empty answer). Throws only when every
 * provider has been tried — and the message says which, and why each declined,
 * because "the AI didn't work" is not something a user can act on.
 */
export async function completeText(opts: CompleteTextOptions): Promise<AiCompletion> {
  const available = configuredProviders();
  const label = opts.label ?? 'ai';
  if (!available.length) {
    throw new Error(
      'No AI provider is configured — set GROQ_API_KEY or CLAUDE_API_KEY in this environment.',
    );
  }

  const order = providerOrder(opts.prefer ?? ['groq', 'claude'], available);
  const failures: string[] = [];

  for (const provider of order) {
    const t0 = Date.now();
    try {
      const text = provider === 'groq' ? await callGroq(opts) : await callClaude(opts);
      if (!text.trim()) throw new Error('empty response');
      console.log(`[ai] ${label}: ${provider} answered in ${Date.now() - t0}ms (${text.length} chars)`);
      return { text, provider };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${provider}: ${message.slice(0, 160)}`);
      console.warn(`[ai] ${label}: ${provider} failed — ${message.slice(0, 200)}`);
    }
  }

  throw new Error(`Every AI provider failed (${failures.join('; ')})`);
}
