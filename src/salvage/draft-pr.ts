// Opens a draft PR for a salvageable agent run, pinning the load-bearing
// order: label first, PR second. The label goes on the SOURCE issue (the PR
// doesn't exist yet at the call site) — it blocks the next dispatcher cycle
// from re-dispatching against an in-progress salvage. `addLabel` throws on
// transport failure (#36); we do NOT catch, because the throw is the
// deterministic safety net that stops `createPr` from running and leaving a
// label-less PR behind. Salvage PRs are always drafts; `draft: true` is set
// inline rather than parameterised.

import type { GitHubLabelsClient } from "../github/labels.ts";
import type { CreatePrInput, GitHubPrClient } from "../github/pr.ts";

export const SALVAGE_LABEL = "error:max_turns_salvaged";

export interface SalvageDraftPrDeps {
  readonly labels: Pick<GitHubLabelsClient, "addLabel">;
  readonly pr: Pick<GitHubPrClient, "createPr">;
}

export interface OpenSalvageDraftPrInput {
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

export async function openSalvageDraftPr(
  deps: SalvageDraftPrDeps,
  input: OpenSalvageDraftPrInput,
): Promise<number> {
  await deps.labels.addLabel(input.issueNumber, SALVAGE_LABEL);

  const createInput: CreatePrInput = {
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    draft: true,
  };
  const pr = await deps.pr.createPr(createInput);
  return pr.number;
}
