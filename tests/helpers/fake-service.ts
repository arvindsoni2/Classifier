import type { Proposal, Result } from '../../src/domain/contracts.js';
import type { Batch } from '../../src/adapters/persistence/repositories.js';
import type { ProviderHealth } from '../../src/cli/doctor.js';
import type { ApplicationService } from '../../src/http/server.js';

/** Fake application service: records calls, returns canned data. */
export class FakeService implements ApplicationService {
  readonly calls: { method: string; args: unknown[] }[] = [];
  failNext: { code: 'INVALID_DECISION' | 'STALE' | 'OUT_OF_SCOPE'; detail: string } | null = null;

  private ok<T>(method: string, value: T): Result<T> {
    this.calls.push({ method, args: [] });
    return { ok: true, value };
  }

  async createBatch(rootId: string): Promise<Result<Batch>> {
    this.calls.push({ method: 'createBatch', args: [rootId] });
    return { ok: true, value: { id: 'batch-1', rootId, stage: 'discovery', createdAt: '2026-10-07T10:00:00.000Z', cancellationRequested: false } };
  }

  async getBatch(batchId: string): Promise<Result<Batch>> {
    this.calls.push({ method: 'getBatch', args: [batchId] });
    return { ok: true, value: { id: batchId, rootId: 'root-1', stage: 'review', createdAt: '2026-10-07T10:00:00.000Z', cancellationRequested: false } };
  }

  async replaceTaxonomy(body: unknown): Promise<Result<{ revision: number; mappingHash: string }>> {
    this.calls.push({ method: 'replaceTaxonomy', args: [body] });
    return { ok: true, value: { revision: 2, mappingHash: 'd'.repeat(64) } };
  }

  async listProposals(batchId: string): Promise<Result<{ proposals: Proposal[]; decisions: Record<string, unknown> }>> {
    this.calls.push({ method: 'listProposals', args: [batchId] });
    // Hostile-looking names are DATA the UI must escape, never instructions.
    const hostile: Proposal = {
      id: 'proposal-1',
      version: 1,
      itemId: 'item-1',
      categoryId: 'cat-invoices',
      destinationId: 'dest-invoices',
      basename: '<script>alert(1)</script>$(touch marker).txt',
      expected: {
        device: '65026',
        inode: '123456789012345678901234567890',
        size: '2048',
        mtimeNs: '1760000000123456789',
        ctimeNs: '1760000000123456789',
        sha256: 'c'.repeat(64),
      },
      taxonomyRevision: 2,
      policyRevision: 3,
      decisionIds: ['decision-1'],
      state: 'pending',
    };
    return { ok: true, value: { proposals: [hostile], decisions: {} } };
  }

  async patchProposal(proposalId: string, body: unknown): Promise<Result<Proposal>> {
    this.calls.push({ method: 'patchProposal', args: [proposalId, body] });
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      return { ok: false, ...failure };
    }
    const listed = await this.listProposals('batch-1');
    if (!listed.ok) return listed;
    const base = listed.value.proposals[0]!;
    return { ok: true, value: { ...base, version: base.version + 1, categoryId: (body as { categoryId?: string }).categoryId ?? base.categoryId } };
  }

  async createApproval(body: unknown): Promise<Result<unknown>> {
    this.calls.push({ method: 'createApproval', args: [body] });
    return { ok: true, value: { id: 'approval-1' } };
  }

  async providerHealth(): Promise<ProviderHealth[]> {
    this.calls.push({ method: 'providerHealth', args: [] });
    return [{ provider: 'rules', status: 'ok', detail: 'healthy' }];
  }
}
