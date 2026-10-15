/**
 * Bundle detection, orchestration side (plan Task 3).
 *
 * A bundle is a directory the organiser treats as one unit instead of a pile of
 * files (spec D21). Two groups of rules, split by what each needs:
 *
 *  - `code_repo` and `code_project` are decided from the directory listing
 *    during the walk, because their contents must never be catalogued.
 *    `bundleScanHook` records the bundle and stops the descent, so nothing
 *    inside becomes an item, a duplicate, or a report line of its own.
 *  - `course`, `album`, `photo_set` and `extracted_archive` are decided after
 *    the scan from catalogue data, because they are properties of the files
 *    inside the directory. `detectBundles` writes their rows; their members stay
 *    in `items` with `bundle_id` set.
 *
 * The rules themselves live in `bundle-rules.ts` as pure functions. This module
 * reads the catalogue, decides the order those rules are applied in, and owns
 * every write. Read-only on the roots throughout (AGENTS.md rule 4).
 */
import {
  codeBundleFor,
  courseParentMatch,
  depthOf,
  matchFor,
  type DirFacts,
  type Match,
} from './bundle-rules.js';
import type { ScanDirectoryContext, ScanHooks } from './scanner.js';
import type { BundleType, CatalogueStore } from './store.js';

export interface BundleRowView {
  id: number;
  rootId: number;
  relPath: string;
  type: BundleType;
  parentBundleId: number | null;
  rule: string;
  memberCount: number | null;
  totalSize: number | null;
  detectedScan: number;
}

export interface BundleDetection {
  type: BundleType;
  relPath: string;
  rule: string;
  memberCount: number | null;
  totalSize: number | null;
}

/**
 * The scanner hook that records walk-stopping bundles. Returning `false` stops
 * the descent, so the directory is recorded and nothing inside it becomes an
 * item.
 *
 * The configured root is never a bundle: bundling it would hide the entire root,
 * which is the one outcome the catalogue exists to prevent.
 */
export function bundleScanHook(store: CatalogueStore): NonNullable<ScanHooks['onDirectory']> {
  return (dir: ScanDirectoryContext): boolean | void => {
    if (dir.relPath === '') return;
    const shape = codeBundleFor(dir.names);
    if (shape === null) return;
    store.upsertBundle({
      rootId: dir.rootId,
      relPath: dir.relPath,
      type: shape.type,
      parentBundleId: null,
      rule: shape.rule,
      memberCount: null,
      totalSize: null,
      detectedScan: dir.scanId,
    });
    return false;
  };
}

/** A bundle written in this pass, with the figures a possible parent needs. */
interface RecordedBundle extends Match {
  id: number;
}

interface DirRowView {
  id: number;
  root_id: number;
  rel_path: string;
}

interface MemberRow {
  dir_id: number;
  name: string;
  kind: string;
  size: number;
}

/** One directory's place in the tree: its facts and its immediate children. */
interface TreeNode {
  id: number;
  rootId: number;
  facts: DirFacts;
  /** Immediate subdirectories, by directory id. */
  childIds: number[];
}

function parentRelPathOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash < 0 ? '' : relPath.slice(0, slash);
}

/** Reads the scan's directories and their non-missing members from the catalogue. */
function readTree(store: CatalogueStore, scanId: number): TreeNode[] {
  const dirRows = store.db
    .prepare('SELECT id, root_id, rel_path FROM dirs WHERE last_seen_scan = ? ORDER BY rel_path')
    .all(scanId) as DirRowView[];

  const memberRows = store.db
    .prepare(
      `SELECT dir_id, name, kind, size FROM items
       WHERE status <> 'missing' AND dir_id IS NOT NULL
       ORDER BY dir_id, name`,
    )
    .all() as MemberRow[];

  const membersByDir = new Map<number, MemberRow[]>();
  for (const row of memberRows) {
    const list = membersByDir.get(row.dir_id);
    if (list === undefined) membersByDir.set(row.dir_id, [row]);
    else list.push(row);
  }

  const nodes = new Map<string, TreeNode>();
  for (const dir of dirRows) {
    const files = (membersByDir.get(dir.id) ?? []).map((row) => ({ name: row.name, kind: row.kind, size: row.size }));
    nodes.set(`${dir.root_id}:${dir.rel_path}`, {
      id: dir.id,
      rootId: dir.root_id,
      facts: { relPath: dir.rel_path, files, childNames: [], siblingArchives: [] },
      childIds: [],
    });
  }

  for (const dir of dirRows) {
    if (dir.rel_path === '') continue;
    const key = `${dir.root_id}:${dir.rel_path}`;
    const own = nodes.get(key);
    const parent = nodes.get(`${dir.root_id}:${parentRelPathOf(dir.rel_path)}`);
    if (own === undefined || parent === undefined) continue;
    parent.facts.childNames.push(own.facts.relPath.slice(parentRelPathOf(dir.rel_path).length + 1));
    parent.childIds.push(dir.id);
    // Archives sitting beside this directory are the `extracted_archive` signal.
    own.facts.siblingArchives = (membersByDir.get(parent.id) ?? [])
      .filter((row) => row.kind === 'archive')
      .map((row) => row.name);
  }

  return [...nodes.values()];
}

/**
 * Detects the catalogue-derived bundle types for a finished scan and writes
 * their rows. Read-only on the roots: every fact comes from SQLite.
 *
 * Two passes, both ordered by depth so results never depend on row order.
 * Deepest first for a directory's own rule, then shallowest first for a course
 * parent adopting its modules: a parent must be able to see every module that
 * already qualifies.
 */
export function detectBundles(store: CatalogueStore, scanId: number): BundleDetection[] {
  const nodes = readTree(store, scanId);
  const byDepth = [...nodes].sort((a, b) => depthOf(b.facts.relPath) - depthOf(a.facts.relPath));
  const detections: BundleDetection[] = [];
  const bundleByDir = new Map<number, RecordedBundle>();

  // Pass 1: every directory's own rule, deepest first. The root is skipped: a
  // bundle is something *inside* a root, and bundling the root itself would
  // hide every file in it.
  //
  // `code_repo` and `code_project` need no check here. The walk stopped at
  // them, so they have no catalogued files and no catalogued subdirectories,
  // and both passes can only match on exactly those. Their precedence is
  // structural, not a comparison.
  for (const node of byDepth) {
    if (node.facts.relPath === '') continue;
    const match = matchFor(node.facts);
    if (match === null) continue;
    bundleByDir.set(node.id, writeBundle(store, scanId, node, match));
    detections.push({ ...match, relPath: node.facts.relPath });
  }

  // Pass 2: a course parent adopts its numbered module bundles.
  for (const node of [...byDepth].reverse()) {
    if (node.facts.relPath === '') continue;
    if (bundleByDir.has(node.id)) continue;
    const children = courseChildrenOf(node, bundleByDir);
    const match = courseParentMatch(node.facts.childNames, children);
    if (match === null) continue;
    const parent = writeBundle(store, scanId, node, match);
    for (const child of children) store.setBundleParent(child.id, parent.id);
    detections.push({ ...match, relPath: node.facts.relPath });
  }

  return detections.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

/** The module bundles of `node` that a parent course could adopt. */
function courseChildrenOf(node: TreeNode, bundleByDir: Map<number, RecordedBundle>): RecordedBundle[] {
  const children: RecordedBundle[] = [];
  for (const childId of node.childIds) {
    const bundle = bundleByDir.get(childId);
    if (bundle?.type === 'course') children.push(bundle);
  }
  return children;
}

/**
 * Writes the bundle row, points its directory and its items at it, and returns
 * what a possible parent will need.
 *
 * `extracted_archive` is the one type that owns a *subtree* rather than a
 * directory. An archive's contents are rarely flat — on Arvind's roots one had
 * 23 files across 14 directories — so members, counts and total size cover
 * everything below the directory, and a bundle found inside becomes its child
 * while keeping its own files. Every other type attaches by directory id, which
 * is what stops a member being claimed twice.
 */
function writeBundle(store: CatalogueStore, scanId: number, node: TreeNode, match: Match): RecordedBundle {
  if (match.type === 'extracted_archive') return writeArchiveBundle(store, scanId, node, match);

  const bundleId = store.upsertBundle({
    rootId: node.rootId,
    relPath: node.facts.relPath,
    type: match.type,
    parentBundleId: null,
    rule: match.rule,
    memberCount: match.memberCount,
    totalSize: match.totalSize,
    detectedScan: scanId,
  });
  store.setDirBundle(node.id, bundleId);
  store.setItemsBundle(node.id, bundleId);
  return { ...match, id: bundleId };
}

/** The archive case: one subtree, counted and adopted whole. */
function writeArchiveBundle(
  store: CatalogueStore,
  scanId: number,
  node: TreeNode,
  match: Match,
): RecordedBundle {
  const stats = store.subtreeItemStats(node.rootId, node.facts.relPath);
  const bundleId = store.upsertBundle({
    rootId: node.rootId,
    relPath: node.facts.relPath,
    type: match.type,
    parentBundleId: null,
    rule: match.rule,
    memberCount: stats.files,
    totalSize: stats.bytes,
    detectedScan: scanId,
  });
  store.setDirBundle(node.id, bundleId);
  // Only files no other bundle claimed: a nested album keeps its own members.
  store.setItemsBundleInSubtree(node.rootId, node.facts.relPath, bundleId);
  store.setBundlesParentInSubtree(node.rootId, node.facts.relPath, bundleId);
  return { ...match, id: bundleId, memberCount: stats.files, totalSize: stats.bytes };
}

/** Every bundle, ordered by root then path, for reports and tests. */
export function listBundles(store: CatalogueStore): BundleRowView[] {
  return store.db
    .prepare(
      `SELECT id, root_id AS rootId, rel_path AS relPath, type,
              parent_bundle_id AS parentBundleId, rule,
              member_count AS memberCount, total_size AS totalSize,
              detected_scan AS detectedScan
       FROM bundles ORDER BY root_id, rel_path`,
    )
    .all() as BundleRowView[];
}