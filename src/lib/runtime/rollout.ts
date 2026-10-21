import { z } from 'zod';

export const ROLLOUT_FLAGS = {
  runtime: 'MAX_RUNTIME_V1',
  queries: 'MAX_EXTENDED_QUERIES',
  handoff: 'MAX_HANDOFF',
  marketing: 'MAX_MARKETING',
} as const;
export type RolloutFeature = keyof typeof ROLLOUT_FLAGS;
const features = ['runtime', 'queries', 'handoff', 'marketing'] as const;
const schema = z.record(
  z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  z.array(z.enum(features)).max(features.length),
);

/** Exact organization IDs only. Missing/malformed configuration never enables a tenant. */
function configuration(): { state: 'missing' | 'invalid' | 'configured'; organizations: Record<string, RolloutFeature[]> } {
  const raw = process.env.MAX_ROLLOUT_ORGS;
  if (!raw?.trim()) return { state: 'missing', organizations: {} };
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success
      ? { state: 'configured', organizations: parsed.data }
      : { state: 'invalid', organizations: {} };
  } catch {
    return { state: 'invalid', organizations: {} };
  }
}

export function rolloutStatus(orgId?: string) {
  const config = configuration();
  const selected = orgId && Object.hasOwn(config.organizations, orgId) ? config.organizations[orgId] : [];
  return {
    configuration: config.state,
    scope: orgId ? 'organization' as const : 'unselected' as const,
    orgId: orgId ?? null,
    features: Object.fromEntries(features.map(feature => {
      const globalEnabled = process.env[ROLLOUT_FLAGS[feature]] === 'true';
      const organizationEnabled = selected.includes(feature);
      return [feature, { globalEnabled, organizationEnabled, enabled: globalEnabled && organizationEnabled }];
    })) as Record<RolloutFeature, { globalEnabled: boolean; organizationEnabled: boolean; enabled: boolean }>,
  };
}

export function featureEnabled(feature: RolloutFeature, orgId?: string): boolean {
  return rolloutStatus(orgId).features[feature].enabled;
}

/** Handoff and marketing also need durable intents even if the runtime-only switch is off. */
export function durableRuntimeEnabled(orgId: string): boolean {
  const status = rolloutStatus(orgId).features;
  return status.runtime.enabled || status.handoff.enabled || status.marketing.enabled;
}
