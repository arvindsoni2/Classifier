/**
 * Explicit CLI verbs (LLD §7, plan Task 9). Every verb calls the same
 * application service the HTTP surface uses: `apply` requires an approval
 * id and exact action-set hash and can never bypass web approvals or make
 * a provider write directly.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Id, Revision } from '../domain/contracts.js';
import { Organiser } from '../application/organiser.js';
import { probeProviders, loadProviderConfig } from './doctor.js';
import { serveReview } from './serve.js';

export interface CliOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export const CLI_VERBS = [
  'scan',
  'classify',
  'review',
  'approve',
  'apply',
  'undo',
  'resume',
  'status',
  'taxonomy',
  'export',
  'eval:fixture',
  'doctor',
] as const;

export type Verb = (typeof CLI_VERBS)[number];

function envDefault(options: CliOptions, name: string, fallback: string): string {
  return options.env[name] ?? fallback;
}

function organiserFor(options: CliOptions): Organiser {
  const options2: import('../application/organiser.js').OrganiserOptions = {
    dbPath: envDefault(options, 'ORGANISER_DB', join(options.cwd, 'organiser.sqlite')),
  };
  if (options.env.ORGANISER_ROOT !== undefined) options2.rootPath = options.env.ORGANISER_ROOT;
  if (options.env.FSOPS_BINARY !== undefined) options2.helperBinary = options.env.FSOPS_BINARY;
  return new Organiser(options2);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Runs one verb and returns the process exit code. */
export async function runCli(argv: readonly string[], options: CliOptions): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === undefined || !(CLI_VERBS as readonly string[]).includes(verb)) {
    console.error(`unknown verb ${JSON.stringify(verb)}; supported verbs: ${CLI_VERBS.join(', ')}`);
    return 2;
  }
  const typed = verb as Verb;

  if (typed === 'eval:fixture') {
    const { runFixtureCli } = await import('../eval/fixture.js');
    await runFixtureCli();
    return 0;
  }

  if (typed === 'doctor') {
    print({ providers: await probeProviders(loadProviderConfig()) });
    return 0;
  }

  if (typed === 'review') {
    // `review` with no further verb starts the authenticated review server;
    // the plan also reserves it as the review-list verb, so `review --list`
    // prints proposals through the same service without any server.
    if (rest[0] === '--list') {
      const organiser = organiserFor(options);
      try {
        const listed = await organiser.listProposals();
        if (!listed.ok) {
          console.error(`${listed.code}: ${listed.detail}`);
          return 1;
        }
        print({
          proposals: listed.value.map((proposal) => ({
            id: proposal.id,
            basename: proposal.basename,
            destinationId: proposal.destinationId,
            version: proposal.version,
            state: proposal.state,
          })),
        });
        return 0;
      } finally {
        organiser.close();
      }
    }
    await serveReview(options, organiserFor);
    return 0;
  }

  const organiser = organiserFor(options);
  try {
    switch (typed) {      case 'scan': {
        const result = await organiser.scan(rest[0]);
        print(result);
        return 0;
      }
      case 'classify': {
        const providerFlag = rest.indexOf('--provider');
        const provider = providerFlag >= 0 ? (rest[providerFlag + 1] ?? 'rules') : 'rules';
        const result = await organiser.classify(undefined, provider as 'rules' | 'clef' | 'laya' | 'jev');
        print(result);
        return 0;
      }
      case 'approve': {
        const approval = await organiser.approveAll();
        if (!approval.ok) {
          console.error(`${approval.code}: ${approval.detail}`);
          return 1;
        }
        print(approval.value);
        return 0;
      }
      case 'apply': {
        const approvalFlag = rest.indexOf('--approval');
        const hashFlag = rest.indexOf('--hash');
        const approvalId = approvalFlag >= 0 ? rest[approvalFlag + 1] : undefined;
        const actionSetHash = hashFlag >= 0 ? rest[hashFlag + 1] : undefined;
        if (approvalId === undefined || actionSetHash === undefined) {
          console.error('apply requires --approval <id> --hash <actionSetHash>');
          return 2;
        }
        const result = await organiser.apply(approvalId, actionSetHash);
        print(result);
        return result.results.some((entry) => entry.outcome === 'applied') ? 0 : 1;
      }
      case 'undo': {
        print(await organiser.undoAll());
        return 0;
      }
      case 'resume': {
        print(await organiser.resume());
        return 0;
      }
      case 'status': {
        print({ providers: await organiser.providerHealth() });
        return 0;
      }
      case 'taxonomy': {
        // Display the active taxonomy, its curation status and the discovered
        // destination catalogue; `--review` approves the current tree through
        // the same service the UI uses (spec review R9).
        const taxonomy = organiser.getTaxonomy();
        if (!taxonomy.ok) {
          console.error(`${taxonomy.code}: ${taxonomy.detail}`);
          return 1;
        }
        if (rest[0] === '--review') {
          const mappings = taxonomy.value.tree
            .filter((node) => node.destinationId !== null)
            .map((node) => ({ categoryId: node.id, destinationId: node.destinationId as string }));
          const reviewed = await organiser.replaceTaxonomy({
            expectedRevision: taxonomy.value.revision,
            tree: taxonomy.value.tree,
            mappings,
          });
          if (!reviewed.ok) {
            console.error(`${reviewed.code}: ${reviewed.detail}`);
            return 1;
          }
          print({ reviewed: reviewed.value });
          return 0;
        }
        print(taxonomy.value);
        return 0;
      }
      case 'export': {
        const outDir = rest[0] ?? 'build/export';
        const { exportRun, writeReport } = await import('../eval/report.js');
        const { scoreRun } = await import('../eval/metrics.js');
        const { runEvaluation } = await import('../eval/runner.js');
        const { loadDataset, loadLabels } = await import('../eval/dataset.js');
        const { RulesProvider } = await import('../adapters/providers/rules.js');
        const dataset = loadDataset(join(options.cwd, 'tests', 'fixtures', 'eval'));
        if (!dataset.ok) {
          console.error(`${dataset.code}: ${dataset.detail}`);
          return 1;
        }
        const labels = loadLabels(join(options.cwd, 'tests', 'fixtures', 'eval'));
        if (!labels.ok) {
          console.error(`${labels.code}: ${labels.detail}`);
          return 1;
        }
        const run = await runEvaluation(dataset.value, [new RulesProvider()], {
          split: 'all',
          evidenceTreatment: 'compact_text',
        });
        const report = scoreRun(run, labels.value);
        const exported = await exportRun(run, dataset.value, labels.value, { outDir });
        if (!exported.ok) {
          console.error(`${exported.code}: ${exported.detail}`);
          return 1;
        }
        writeReport(report, outDir);
        print({ outDir, files: exported.value });
        return 0;
      }
      default:
        console.error(`verb ${typed} is not implemented`);
        return 2;
    }
  } catch (error) {
    console.error(`${(error as Error).message}`);
    return 1;
  } finally {
    organiser.close();
  }
}

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isDirectRun()) {
  void runCli(process.argv.slice(2), { cwd: process.cwd(), env: process.env }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    },
  );
}

export type { Id, Revision };
