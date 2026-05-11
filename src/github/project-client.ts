// Single I/O initialization surface for src/github/. Resolves a Projects v2
// project by (owner, project, ownerType) and exposes board-position-ordered
// item enumeration. Sibling tickets (#20 issues, #21 labels/PR helpers)
// will consume this client via DI; no consumer is wired here.
//
// Two semantic invariants are load-bearing:
//
//   - Org-aware dispatch is explicit: ownerType picks `organization(login:)`
//     vs `user(login:)`. NO try/catch fallback — that would mask every
//     GraphQL error (auth, rate-limit, transient) as "wrong owner type".
//   - Native ordering, never derived: items are fetched via
//     `ProjectV2ItemOrderField.POSITION`. Client-side sorting on
//     issueNumber would put split-children out of order and break manual
//     board reorder.
//
// The constructor is private; `initialize` is the only entry point. Method
// bodies can rely on the cached IDs being resolved without defensive guards.

export type OwnerType = "user" | "organization";

// Narrow project-item shape — only fields some downstream consumer reads.
// Per the #6 narrow-types rule, do NOT widen for hypothetical future
// consumers; sibling tickets widen when they need body / blockedBy / etc.
export interface ProjectItem {
  readonly id: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly url: string;
  // GraphQL Issue.state enum — "OPEN" | "CLOSED" (uppercase). Empty string
  // sentinel on missing/malformed response — neither value, so any predicate
  // gated on "CLOSED" / "OPEN" skips it (safer than defaulting to either).
  readonly state: string;
}

export interface InitializeOpts {
  readonly owner: string;
  readonly project: number;
  readonly ownerType: OwnerType;
}

// DI shape mirrors @octokit/graphql's exported callable. Production
// wiring (later ticket) is one line: `graphql.defaults({ headers: ... })`.
// Tests hand-roll a function — no mock library, no @octokit dep.
export type GraphQLTransport = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

const INIT_QUERY = (f: "organization" | "user"): string =>
  `query($owner:String!,$number:Int!){${f}(login:$owner){projectV2(number:$number){id fields(first:30){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`;

const ITEMS_QUERY = `query($projectId:ID!,$cursor:String){node(id:$projectId){... on ProjectV2{items(first:100,after:$cursor,orderBy:{field:POSITION,direction:ASC}){pageInfo{hasNextPage endCursor}nodes{id fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}content{... on Issue{number title url state labels(first:10){nodes{name}}}}}}}}}`;

const SET_STATUS_MUTATION =
  "mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}";

interface StatusFieldNode {
  readonly id: string;
  readonly name: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
}

type InitResponse = {
  readonly [K in "organization" | "user"]?: {
    readonly projectV2: {
      readonly id: string;
      readonly fields: { readonly nodes: readonly (StatusFieldNode | null | undefined)[] };
    } | null;
  } | null;
};

interface ItemNode {
  readonly id: string;
  readonly fieldValueByName: { readonly name?: unknown } | null;
  readonly content: {
    readonly number?: unknown;
    readonly title?: unknown;
    readonly url?: unknown;
    readonly state?: unknown;
    readonly labels?: { readonly nodes?: readonly { readonly name?: unknown }[] };
  } | null;
}

interface ItemsResponse {
  readonly node: {
    readonly items: {
      readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      readonly nodes: readonly ItemNode[];
    };
  } | null;
}

export class GitHubProjectClient {
  // 50 pages * 100 items = 5000 items. Cap exists to surface a runaway
  // loop (echoed endCursor, broken hasNextPage) rather than silently
  // burning the GraphQL budget. v1 #203 was the precedent for paginating
  // at all; the cap is the regression guard against the next variant.
  private static readonly MAX_PAGES = 50;

  private constructor(
    private readonly transport: GraphQLTransport,
    readonly projectId: string,
    readonly statusFieldId: string,
    readonly statusOptionIdsByName: ReadonlyMap<string, string>,
  ) {}

  static async initialize(
    opts: InitializeOpts,
    transport: GraphQLTransport,
  ): Promise<GitHubProjectClient> {
    const ownerField = opts.ownerType === "organization" ? "organization" : "user";
    const result = (await transport(INIT_QUERY(ownerField), {
      owner: opts.owner,
      number: opts.project,
    })) as InitResponse;
    const project = result[ownerField]?.projectV2;
    if (!project) {
      throw new Error(`Project not found: ${opts.owner}/${opts.project}`);
    }
    const statusField = project.fields.nodes.find(
      (n): n is StatusFieldNode => n != null && n.name === "Status",
    );
    if (!statusField) {
      throw new Error("Status field not found on project");
    }
    const optionMap = new Map<string, string>();
    for (const opt of statusField.options) optionMap.set(opt.name, opt.id);
    return new GitHubProjectClient(transport, project.id, statusField.id, optionMap);
  }

  // setItemStatus takes the project-item id (NOT issue number; mixing
  // yields `Could not resolve to a node`) and resolves the option id via
  // the cached `statusOptionIdsByName` map from `initialize` — no
  // round-trip, no fallback. Unknown status name throws with the name.
  async setItemStatus(itemId: string, statusName: string): Promise<void> {
    const optionId = this.statusOptionIdsByName.get(statusName);
    if (!optionId) {
      throw new Error(`setItemStatus: no Status option named "${statusName}"`);
    }
    await this.transport(SET_STATUS_MUTATION, {
      projectId: this.projectId,
      itemId,
      fieldId: this.statusFieldId,
      optionId,
    });
  }

  async listItemsInBoardOrder(): Promise<readonly ProjectItem[]> {
    const out: ProjectItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (true) {
      pages += 1;
      if (pages > GitHubProjectClient.MAX_PAGES) {
        throw new Error(
          `listItemsInBoardOrder exceeded ${GitHubProjectClient.MAX_PAGES} pages — runaway pagination? Aggregated ${out.length} items so far. If the project is genuinely this large, raise MAX_PAGES; otherwise check the endCursor logic for a loop.`,
        );
      }
      const variables: Record<string, unknown> = { projectId: this.projectId };
      if (cursor !== null) variables.cursor = cursor;
      const result = (await this.transport(ITEMS_QUERY, variables)) as ItemsResponse;
      const items = result.node?.items;
      if (!items) break;
      for (const node of items.nodes) {
        const mapped = mapItem(node);
        if (mapped) out.push(mapped);
      }
      if (!items.pageInfo.hasNextPage || !items.pageInfo.endCursor) break;
      cursor = items.pageInfo.endCursor;
    }
    return out;
  }
}

function mapItem(node: ItemNode): ProjectItem | null {
  const content = node.content;
  if (!content || typeof content.number !== "number") return null;
  const labels: string[] = [];
  for (const l of content.labels?.nodes ?? []) {
    if (typeof l.name === "string") labels.push(l.name);
  }
  const status =
    node.fieldValueByName && typeof node.fieldValueByName.name === "string"
      ? node.fieldValueByName.name
      : "no-status";
  return {
    id: node.id,
    issueNumber: content.number,
    title: typeof content.title === "string" ? content.title : "",
    url: typeof content.url === "string" ? content.url : "",
    status,
    labels,
    state: typeof content.state === "string" ? content.state : "",
  };
}
