import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import {
  isLocalAuthProviderBaseUrl,
  resolveProviderConfig,
} from "../../agents/model-auth-provider-config.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { modelCatalogLogicalKey } from "../../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayModelThinkingProfile } from "../session-utils-model.js";
import {
  buildPublicModelProjection,
  resolveModelChoiceAgentRuntime,
} from "./models-list-public-projection.js";

export type ApiKeyProviderCapabilities = {
  providers: ReadonlyMap<string, boolean>;
  resolveProvider(provider: string): string;
};

/** Projects one prepared catalog row without exposing private route metadata. */
export function createPublicModelsListProjector(params: {
  thinkingCatalog: ModelCatalogEntry[];
  routeVariants: readonly ModelCatalogEntry[];
  cfg: OpenClawConfig;
  agentId: string;
  configuredEntriesByKey: ReadonlyMap<
    string,
    {
      aliases: string[];
      aliasDisabled: boolean;
      tags: Set<string>;
    }
  >;
  includeInput?: boolean;
  preserveUnknownAvailability?: boolean;
  apiKeyCapabilities?: ApiKeyProviderCapabilities;
}) {
  // Route rows retain identity across reads; keep display/thinking work outside the hot overlay.
  const prepared = new WeakMap<ModelCatalogEntry, ModelChoice>();
  const routeVariantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const route of params.routeVariants) {
    const key = modelCatalogLogicalKey(route);
    const variants = routeVariantsByKey.get(key) ?? [];
    variants.push(route);
    routeVariantsByKey.set(key, variants);
  }
  return (entry: ModelCatalogEntry, evaluation: ModelAuthAvailabilityEvaluation): ModelChoice => {
    let preparedEntry = prepared.get(entry);
    if (!preparedEntry) {
      const configuredEntry = params.configuredEntriesByKey.get(modelKey(entry.provider, entry.id));
      const alias = configuredEntry?.aliases.at(-1);
      const publicEntry = configuredEntry?.aliasDisabled
        ? Object.assign({}, entry, { alias: undefined })
        : alias && alias !== entry.alias
          ? Object.assign({}, entry, { alias })
          : entry;
      const capabilityProvider = params.apiKeyCapabilities?.resolveProvider(entry.provider);
      const agentRuntime = resolveModelChoiceAgentRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
      });
      const thinkingProfile =
        typeof publicEntry.reasoning !== "boolean"
          ? undefined
          : resolveGatewayModelThinkingProfile({
              cfg: params.cfg,
              agentId: params.agentId,
              provider: entry.provider,
              model: entry.id,
              modelCatalog: params.thinkingCatalog,
              configuredReasoning: publicEntry.configuredReasoning ?? publicEntry.reasoning,
              thinkingPolicyProvider: publicEntry.thinkingPolicyProvider,
            });
      const fastModeState = resolveFastModeState({
        cfg: params.cfg,
        agentId: params.agentId,
        provider: entry.provider,
        model: entry.id,
      });
      preparedEntry = {
        ...buildPublicModelProjection(publicEntry),
        ...(configuredEntry?.tags.size ? { tags: [...configuredEntry.tags] } : {}),
        ...(agentRuntime ? { agentRuntime } : {}),
        ...thinkingProfile,
        ...(fastModeState.source === "default" ? {} : { effectiveFastMode: fastModeState.mode }),
        ...(capabilityProvider && params.apiKeyCapabilities?.providers.has(capabilityProvider)
          ? {
              apiKeySupported: params.apiKeyCapabilities.providers.get(capabilityProvider) === true,
            }
          : {}),
        ...(params.includeInput && entry.input?.length ? { input: entry.input } : {}),
      };
      prepared.set(entry, preparedEntry);
    }
    const syntheticLocalAvailable = hasSyntheticLocalCatalogRoute({
      cfg: params.cfg,
      entry,
      evaluation,
      routeVariants: routeVariantsByKey.get(modelCatalogLogicalKey(entry)) ?? [],
    });
    const available = syntheticLocalAvailable ? true : evaluation.availability;
    const projectedAvailability = params.preserveUnknownAvailability
      ? available
      : (available ?? false);
    return Object.assign(
      {},
      preparedEntry,
      projectedAvailability === undefined ? {} : { available: projectedAvailability },
      projectedAvailability === false && evaluation.unavailableReason
        ? {
            unavailableReason: evaluation.unavailableReason,
            ...(evaluation.unavailableUntil !== undefined
              ? { unavailableUntil: evaluation.unavailableUntil }
              : {}),
          }
        : {},
    );
  };
}

function hasSyntheticLocalCatalogRoute(params: {
  cfg: OpenClawConfig;
  entry: ModelCatalogEntry;
  evaluation: ModelAuthAvailabilityEvaluation;
  routeVariants: readonly ModelCatalogEntry[];
}): boolean {
  if (
    params.evaluation.routeResolution !== null ||
    normalizeProviderId(params.entry.provider) === "openai" ||
    params.evaluation.evidence !== "synthetic"
  ) {
    return false;
  }
  const routes = [params.entry, ...params.routeVariants];
  const configuredBaseUrl = resolveProviderConfig(
    params.cfg,
    params.entry.provider,
  )?.baseUrl?.trim();
  const concreteBaseUrls = routes.flatMap((route) =>
    typeof route.baseUrl === "string" && route.baseUrl.trim() ? [route.baseUrl] : [],
  );
  if (configuredBaseUrl) {
    concreteBaseUrls.push(configuredBaseUrl);
  }
  if (concreteBaseUrls.length > 0) {
    return concreteBaseUrls.every((baseUrl) => isLocalAuthProviderBaseUrl(baseUrl));
  }
  // The native Ollama transport owns a loopback default when no route URL was authored.
  return routes.some((route) => route.api === "ollama");
}

export function applySyntheticLocalCatalogAvailability(params: {
  cfg: OpenClawConfig;
  entry: ModelCatalogEntry;
  evaluation: ModelAuthAvailabilityEvaluation;
  routeVariants: readonly ModelCatalogEntry[];
}): ModelAuthAvailabilityEvaluation {
  return hasSyntheticLocalCatalogRoute(params)
    ? {
        ...params.evaluation,
        availability: true,
        unavailableReason: undefined,
        unavailableUntil: undefined,
      }
    : params.evaluation;
}
