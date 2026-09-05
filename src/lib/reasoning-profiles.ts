export const REASONING_PROFILE_IDS = [
  'workers-ai-gpt-oss',
  'workers-ai-glm-5.3',
  'workers-ai-kimi-k2.6',
] as const;

export type ReasoningProfileId = typeof REASONING_PROFILE_IDS[number];
const PI_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PiReasoningLevel = typeof PI_REASONING_LEVELS[number];

interface StoredRouteSettings {
  contextWindow: number;
  reasoningProfile: ReasoningProfileId;
}

export interface RouteSettings {
  contextWindows: Record<string, number>;
  reasoningProfiles: Record<string, ReasoningProfileId>;
}

function isReasoningProfileId(value: unknown): value is ReasoningProfileId {
  return typeof value === 'string' && (REASONING_PROFILE_IDS as readonly string[]).includes(value);
}

export function isPiReasoningLevel(value: unknown): value is PiReasoningLevel {
  return typeof value === 'string' && (PI_REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * The existing route-context KV value now stores the route's context window and
 * reasoning profile together. Numeric values remain readable for legacy routes,
 * but intentionally have no profile until an administrator selects one.
 */
export function parseRouteSettings(raw: unknown): RouteSettings {
  const contextWindows: Record<string, number> = {};
  const reasoningProfiles: Record<string, ReasoningProfileId> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { contextWindows, reasoningProfiles };

  for (const [route, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      contextWindows[route] = value;
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as Partial<StoredRouteSettings>;
    if (typeof candidate.contextWindow === 'number' && Number.isInteger(candidate.contextWindow) && candidate.contextWindow > 0) {
      contextWindows[route] = candidate.contextWindow;
    }
    if (isReasoningProfileId(candidate.reasoningProfile)) {
      reasoningProfiles[route] = candidate.reasoningProfile;
    }
  }
  return { contextWindows, reasoningProfiles };
}

export function serializeRouteSettings(
  contextWindows: Record<string, number>,
  reasoningProfiles: Record<string, ReasoningProfileId>,
): Record<string, StoredRouteSettings | number> {
  return Object.fromEntries(Object.keys(contextWindows).map((route) => {
    const profile = reasoningProfiles[route];
    return [route, isReasoningProfileId(profile)
      ? { contextWindow: contextWindows[route], reasoningProfile: profile }
      : contextWindows[route]];
  }));
}

function commonEffort(level: PiReasoningLevel): 'low' | 'medium' | 'high' | null {
  if (level === 'off') return null;
  if (level === 'minimal' || level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  return 'high';
}

function glmEffort(level: PiReasoningLevel): 'low' | 'high' | 'max' | null {
  if (level === 'off') return null;
  if (level === 'minimal' || level === 'low') return 'low';
  if (level === 'xhigh' || level === 'max') return 'max';
  return 'high';
}

function cleanOwnedReasoningFields(payload: Record<string, unknown>): Record<string, unknown> {
  const translated = { ...payload };
  delete translated.reasoning;
  delete translated.thinking;
  const existing = translated.chat_template_kwargs;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const kwargs = { ...(existing as Record<string, unknown>) };
    delete kwargs.enable_thinking;
    delete kwargs.thinking;
    delete kwargs.clear_thinking;
    translated.chat_template_kwargs = kwargs;
  } else {
    delete translated.chat_template_kwargs;
  }
  return translated;
}

export function translateReasoningRequest(
  payload: Record<string, unknown>,
  profile: ReasoningProfileId,
  level: PiReasoningLevel,
): Record<string, unknown> {
  const translated = cleanOwnedReasoningFields(payload);
  if (profile === 'workers-ai-gpt-oss') {
    translated.reasoning_effort = commonEffort(level);
    return translated;
  }

  const currentKwargs = translated.chat_template_kwargs as Record<string, unknown> | undefined;
  const enabled = level !== 'off';
  if (profile === 'workers-ai-glm-5.3') {
    translated.reasoning_effort = glmEffort(level);
    translated.chat_template_kwargs = {
      ...currentKwargs,
      enable_thinking: enabled,
      clear_thinking: false,
    };
    return translated;
  }

  translated.reasoning_effort = commonEffort(level);
  translated.chat_template_kwargs = {
    ...currentKwargs,
    thinking: enabled,
    clear_thinking: false,
  };
  return translated;
}
