/**
 * The rule this file exists to hold: A FEATURE IS NOT DEAD BECAUSE ONE KEY IS
 * UNSET.
 *
 * Transaction suggestions asked Claude and only Claude, so a deployment holding
 * a Groq key and no Claude key had a button whose entire behaviour was to report
 * a missing environment variable. What's pinned here is the fallback that fixed
 * it — and the two ways a fallback goes wrong:
 *
 *   • A PREFERENCE IS NOT A RESTRICTION — preferring Groq must not mean refusing
 *     Claude on a box that only has Claude;
 *   • FAILURE FALLS THROUGH, IT DOESN'T STOP — a rate-limited or empty first
 *     answer moves to the next provider rather than becoming the user's error;
 *   • WHEN EVERYTHING FAILS, SAY WHAT TO SET — the message names the variables,
 *     because that is the only actionable part of "the AI didn't work".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { groqCreate, claudeCreate } = vi.hoisted(() => ({
  groqCreate: vi.fn(),
  claudeCreate: vi.fn(),
}));

vi.mock('groq-sdk', () => ({
  default: class {
    chat = { completions: { create: groqCreate } };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: claudeCreate };
  },
}));

import { completeText, providerOrder, configuredProviders } from './aiText';

const groqSays = (text: string) => ({ choices: [{ message: { content: text } }] });
const claudeSays = (text: string) => ({ content: [{ type: 'text', text }] });

const ask = () => completeText({ prompt: 'hello', maxTokens: 64, prefer: ['groq', 'claude'] });

let savedGroq: string | undefined;
let savedClaude: string | undefined;

beforeEach(() => {
  savedGroq = process.env.GROQ_API_KEY;
  savedClaude = process.env.CLAUDE_API_KEY;
  groqCreate.mockReset();
  claudeCreate.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (savedGroq === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = savedGroq;
  if (savedClaude === undefined) delete process.env.CLAUDE_API_KEY;
  else process.env.CLAUDE_API_KEY = savedClaude;
  vi.restoreAllMocks();
});

describe('which provider gets asked', () => {
  it('takes the preferred one when both are configured', async () => {
    process.env.GROQ_API_KEY = 'g';
    process.env.CLAUDE_API_KEY = 'c';
    groqCreate.mockResolvedValue(groqSays('{"ok":1}'));

    const result = await ask();

    expect(result).toEqual({ text: '{"ok":1}', provider: 'groq' });
    expect(claudeCreate).not.toHaveBeenCalled();
  });

  it('uses the other one when the preferred key is unset — a preference is not a restriction', async () => {
    delete process.env.GROQ_API_KEY;
    process.env.CLAUDE_API_KEY = 'c';
    claudeCreate.mockResolvedValue(claudeSays('{"ok":1}'));

    const result = await ask();

    expect(result.provider).toBe('claude');
    expect(groqCreate).not.toHaveBeenCalled();
  });

  it('answers from Groq alone when Claude is the one missing — the case that was broken', async () => {
    process.env.GROQ_API_KEY = 'g';
    delete process.env.CLAUDE_API_KEY;
    groqCreate.mockResolvedValue(groqSays('{"results":[]}'));

    await expect(ask()).resolves.toMatchObject({ provider: 'groq' });
  });
});

describe('when a provider fails', () => {
  it('falls through to the next one', async () => {
    process.env.GROQ_API_KEY = 'g';
    process.env.CLAUDE_API_KEY = 'c';
    groqCreate.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
    claudeCreate.mockResolvedValue(claudeSays('{"ok":1}'));

    const result = await ask();

    expect(result.provider).toBe('claude');
  });

  it('treats an empty answer as a failure, not an answer', async () => {
    process.env.GROQ_API_KEY = 'g';
    process.env.CLAUDE_API_KEY = 'c';
    groqCreate.mockResolvedValue(groqSays('   '));
    claudeCreate.mockResolvedValue(claudeSays('{"ok":1}'));

    await expect(ask()).resolves.toMatchObject({ provider: 'claude' });
  });

  it('reports every reason once nothing is left to try', async () => {
    process.env.GROQ_API_KEY = 'g';
    process.env.CLAUDE_API_KEY = 'c';
    groqCreate.mockRejectedValue(new Error('rate limited'));
    claudeCreate.mockRejectedValue(new Error('overloaded'));

    await expect(ask()).rejects.toThrow(/groq: rate limited.*claude: overloaded/s);
  });

  it('names the environment variables when nothing is configured at all', async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.CLAUDE_API_KEY;

    await expect(ask()).rejects.toThrow(/GROQ_API_KEY or CLAUDE_API_KEY/);
    expect(groqCreate).not.toHaveBeenCalled();
    expect(claudeCreate).not.toHaveBeenCalled();
  });
});

describe('providerOrder', () => {
  it('puts preferred providers first, in the order asked', () => {
    expect(providerOrder(['claude', 'groq'], ['groq', 'claude'])).toEqual(['claude', 'groq']);
  });

  it('keeps a configured provider that was never mentioned, as a last resort', () => {
    expect(providerOrder(['groq'], ['groq', 'claude'])).toEqual(['groq', 'claude']);
  });

  it('never returns a provider that has no key', () => {
    expect(providerOrder(['groq', 'claude'], ['claude'])).toEqual(['claude']);
    expect(providerOrder(['groq'], [])).toEqual([]);
  });
});

describe('configuredProviders', () => {
  it('reads the environment, and reads it every time', () => {
    delete process.env.GROQ_API_KEY;
    process.env.CLAUDE_API_KEY = 'c';
    expect(configuredProviders()).toEqual(['claude']);

    process.env.GROQ_API_KEY = 'g';
    expect(configuredProviders()).toEqual(['groq', 'claude']);
  });
});
