# Adapter extension boundary

FR-14: source implementations change independently of the domain services.
This document records the contract an adapter must satisfy and the shape of
the second-source fixture already exercised by the test suite.

## SourceAdapter contract

```ts
interface SourceAdapter {
  capabilities(): SourceCapabilities;
  discover(config: RootConfig): AsyncIterable<Result<Item>>;
  inspect(itemId: Id): Promise<Result<Snapshot>>;
  apply(action: ApprovedAction): Promise<Result<ActionReceipt>>;
}
```

- Discovered values are normalised `Item`s: no absolute paths, no atime, no
  provider-specific fields. `externalId` is a source handle, never an
  unrestricted path.
- `capabilities()` is the authority for mutation: a read-only source
  (actions [], recovery 'none') is refused by construction, not by policy
  after the fact. The mock collection source demonstrates this.
- `apply` receives an ApprovedMove/ActionReceipt pair with pinned identity.
  Unsupported sources answer UNSUPPORTED and leave the filesystem helper out
  of the path entirely.

## Fixture second source

`tests/fixtures/collection-source.ts` (CollectionFixtureSource) discovers
bookmark-style items, participates in classification through the same
provider contract as the filesystem source, and rejects mutation. The
adapter-contract integration test asserts all three behaviours.

## Decision providers

`DecisionProvider` (health/decide/close) is the provider boundary. The
systemone adapter translates the canonical question to the SystemOne wire
format and validates the typed response; an endpoint that answers in a chat
format is recorded as blocked, never substituted (Laya/Clef comparison rules).

## Future adapters (out of scope for v1)

Google Drive, GitHub stars and X bookmarks were considered in the pack and
deliberately deferred: they require their own consent scope, rate-limit and
recovery analysis. The normalised-item contract above is the extension
surface; adding one must not require changes to planner, policy, executor or
evaluation.
