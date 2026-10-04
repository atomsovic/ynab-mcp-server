import type { PlanStaging, StagedReview, StagingScope, StagingSnapshot, StagingStatus } from "../staging/types.js";

/** This client is only constructed after OAuth and current-grant authorization. */
export class DurablePlanStaging implements PlanStaging {
  private stub: DurableObjectStub;
  constructor(namespace: DurableObjectNamespace, private scope: StagingScope) {
    this.stub = namespace.get(namespace.idFromName(JSON.stringify([scope.userId, scope.planId])));
  }
  private async call<T>(path: string, input: object = {}): Promise<T> {
    let response: Response;
    try { response = await this.stub.fetch(`https://staging.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: this.scope, ...input }) }); }
    catch { throw new Error("Private staging is temporarily unavailable"); }
    if (!response.ok) {
      // Do not echo upstream bodies, entity values or credentials.
      throw new Error(response.status === 429 ? "Private staging sync is cooling down; inspect staging status before retrying" :
        response.status === 409 ? "Staging snapshot changed; refresh and review again" : "Private staging operation failed");
    }
    // JSON decoder errors may contain a response-body snippet. Keep those
    // private even when an internal upstream incorrectly returns HTTP 200.
    try { return await response.json() as T; }
    catch { throw new Error("Private staging returned an invalid response"); }
  }
  snapshot() { return this.call<StagingSnapshot>("/snapshot"); }
  sync() { return this.call<StagingSnapshot>("/sync"); }
  status() { return this.call<StagingStatus>("/status"); }
  async saveReviews(revision: number, rows: StagedReview[]) { await this.call("/reviews/save", { revision, rows }); }
  reviews() { return this.call<StagedReview[]>("/reviews/list"); }
  async updateReview(transactionId: string, decision: "pending" | "reviewed" | "dismissed", note: string, questions: string[]) { await this.call("/reviews/update", { transactionId, decision, note, questions }); }
  async clear() { await this.call("/clear"); }
}
