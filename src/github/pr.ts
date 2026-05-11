// Three thin PR-surface I/O ops — `createPr`, `enableAutoMerge`, `mergePr` —
// shared between the dispatcher's loop (`runAutoMerge`) and the salvage flow.
// This module executes decisions; the pure pipeline (`findReadyPrNumber`,
// sibling ticket) decides whether to merge. Single GraphQL transport seam
// from #19 keeps the launcher wiring at one DI point.
//
// Two semantic invariants are load-bearing:
//
//   - `mergePr` returns conflict as a typed value, NOT a thrown error. The
//     loop layer needs to roll project status back from Done → In Code Review
//     when the Done-column merge attempt fails on conflict (v1 lesson
//     2026-05-09 evening). Throwing here would force every caller to catch
//     strings; typing here keeps the substring-classification rule in one
//     well-tested place.
//   - All other methods follow the `src/github/` "errors propagate verbatim"
//     stance. `createPr` and `enableAutoMerge` throw on transport failure
//     so the salvage flow's "addLabel before createPr" ordering surfaces
//     visibly. Asymmetry is deliberate — the test suite pins it.
//
// Does NOT decide whether to merge, does NOT roll back project status, does
// NOT retry across cycles. The loop composes this module's typed result
// with the project-client's status-mutation primitive.

import type { GraphQLTransport } from "./project-client.ts";

export interface PrInfo {
  readonly number: number;
  readonly nodeId: string;
  readonly url: string;
}

export interface CreatePrInput {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly draft?: boolean;
}

export type MergeResult =
  | { readonly merged: true }
  | {
      readonly merged: false;
      readonly reason: "conflict" | "other";
      readonly error: Error;
    };

const REPO_ID_QUERY =
  "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}";

const PR_ID_BY_NUMBER_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}";

const CREATE_PR_MUTATION =
  "mutation($repositoryId:ID!,$title:String!,$body:String!,$baseRefName:String!,$headRefName:String!,$draft:Boolean!){createPullRequest(input:{repositoryId:$repositoryId,title:$title,body:$body,baseRefName:$baseRefName,headRefName:$headRefName,draft:$draft}){pullRequest{id number url}}}";

const ENABLE_AUTO_MERGE_MUTATION =
  "mutation($pullRequestId:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId}){pullRequest{number}}}";

const MERGE_PR_MUTATION =
  "mutation($pullRequestId:ID!){mergePullRequest(input:{pullRequestId:$pullRequestId}){pullRequest{number merged}}}";

interface RepoIdResponse {
  readonly repository: { readonly id: string } | null;
}

interface PrIdByNumberResponse {
  readonly repository: { readonly pullRequest: { readonly id: string } | null } | null;
}

interface CreatePrResponse {
  readonly createPullRequest: {
    readonly pullRequest: { readonly id: string; readonly number: number; readonly url: string };
  };
}

export class GitHubPrClient {
  private constructor(
    private readonly transport: GraphQLTransport,
    private readonly repositoryId: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  static async initialize(
    opts: { owner: string; repo: string },
    transport: GraphQLTransport,
  ): Promise<GitHubPrClient> {
    const result = (await transport(REPO_ID_QUERY, {
      owner: opts.owner,
      name: opts.repo,
    })) as RepoIdResponse;
    if (!result.repository) {
      throw new Error(`Repository not found: ${opts.owner}/${opts.repo}`);
    }
    return new GitHubPrClient(transport, result.repository.id, opts.owner, opts.repo);
  }

  async createPr(input: CreatePrInput): Promise<PrInfo> {
    const result = (await this.transport(CREATE_PR_MUTATION, {
      repositoryId: this.repositoryId,
      title: input.title,
      body: input.body,
      baseRefName: input.base,
      headRefName: input.head,
      draft: input.draft ?? false,
    })) as CreatePrResponse;
    const pr = result.createPullRequest.pullRequest;
    return { number: pr.number, nodeId: pr.id, url: pr.url };
  }

  async enableAutoMerge(prNumber: number): Promise<void> {
    const nodeId = await this.resolvePrNodeId(prNumber);
    await this.transport(ENABLE_AUTO_MERGE_MUTATION, { pullRequestId: nodeId });
  }

  async mergePr(prNumber: number): Promise<MergeResult> {
    try {
      const nodeId = await this.resolvePrNodeId(prNumber);
      await this.transport(MERGE_PR_MUTATION, { pullRequestId: nodeId });
      return { merged: true };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { merged: false, reason: classifyMergeError(error), error };
    }
  }

  private async resolvePrNodeId(prNumber: number): Promise<string> {
    const result = (await this.transport(PR_ID_BY_NUMBER_QUERY, {
      owner: this.owner,
      name: this.repo,
      number: prNumber,
    })) as PrIdByNumberResponse;
    const id = result.repository?.pullRequest?.id;
    if (!id) {
      throw new Error(`Pull request not found: ${this.owner}/${this.repo}#${prNumber}`);
    }
    return id;
  }
}

function classifyMergeError(error: Error): "conflict" | "other" {
  const msg = error.message.toLowerCase();
  if (msg.includes("not mergeable") || msg.includes("merge conflict") || msg.includes("conflict")) {
    return "conflict";
  }
  return "other";
}
