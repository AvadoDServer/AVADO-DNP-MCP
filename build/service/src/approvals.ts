/**
 * "Ask me first": an action from a key with confirmActions waits here until the owner clicks
 * Allow or Don't allow on the AI Connect page, or the wait runs out (then it does not run).
 */
import { randomUUID } from "node:crypto";

export interface PendingApproval {
  id: string;
  who: string;
  tokenId: string;
  /** what the agent wants, in plain words: "Restart Teku" */
  summary: string;
  tool: string;
  target: string;
  createdAt: string;
  expiresAt: string;
}

type Decision = "allowed" | "declined" | "expired";

export class Approvals {
  private pending = new Map<string, { item: PendingApproval; resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Resolves with the owner's decision. At most 10 waiting at once (older ones expire first). */
  request(input: Omit<PendingApproval, "id" | "createdAt" | "expiresAt">, timeoutMs: number): { item: PendingApproval; decision: Promise<Decision> } {
    if (this.pending.size >= 10) {
      const oldest = [...this.pending.keys()][0]!;
      this.decide(oldest, "expired");
    }
    const t = this.now();
    const item: PendingApproval = {
      ...input,
      id: randomUUID(),
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + timeoutMs).toISOString(),
    };
    const decision = new Promise<Decision>((resolve) => {
      // not unref'd: the agent's request is waiting on it
      const timer = setTimeout(() => this.decide(item.id, "expired"), timeoutMs);
      this.pending.set(item.id, { item, resolve, timer });
    });
    return { item, decision };
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.item);
  }

  decide(id: string, decision: Decision): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(decision);
    return true;
  }

  /** A revoked key's waiting actions are declined. */
  dropToken(tokenId: string): void {
    for (const p of [...this.pending.values()]) if (p.item.tokenId === tokenId) this.decide(p.item.id, "declined");
  }
}
