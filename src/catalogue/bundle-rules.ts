/**
 * The bundle rules themselves (plan Task 3), as pure functions of names and
 * counts.
 *
 * Nothing here touches the filesystem or the database. Every rule answers one
 * question about one directory and returns either a verdict or null, and a
 * directory that no rule can decide stays a plain directory. That is the safe
 * default: an undetected bundle costs nothing until someone acts on it, while a
 * wrong bundle would move files as one unit.
 *
 * Thresholds live here as named constants so the plan's numbers can be read off
 * the code, and every comparison is integer arithmetic: no floating-point
 * boundary where 3 of 5 might fall either side of 60%.
 */
import { extensionOf } from './kinds.js';
import type { BundleType } from './store.js';

/** Project markers; a directory holding one is a `code_project`. */
const PROJECT_MARKERS: ReadonlySet<string> = new Set([
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'CMakeLists.txt',
]);

/** Visual Studio solutions are recognised by extension, not by exact name. */
const PROJECT_EXTENSIONS: ReadonlySet<string> = new Set(['sln']);

/** A leading track or lesson number: `01 - intro`, `1. intro`, `2_intro`. */
const LEADING_NUMBER = /^\s*\d{1,3}[ ._-]/;

/** A named sequence marker: `lecture 3`, `Part 2`, `Week 1`, `Episode 12`. */
const SEQUENCE_KEYWORD = /(?:lesson|lecture|module|part|episode|ep|chapter|week|day)\s*\d+/i;

const MIN_COURSE_VIDEOS = 3;
const MIN_ALBUM_TRACKS = 3;
const MIN_PHOTO_IMAGES = 10;
const MIN_PARENT_COURSE_DIRS = 2;
const SEQUENCE_PERCENT = 60;
const IMAGE_PERCENT = 70;

/** One catalogue file, as the rules see it: a name, a kind and a size. */
export interface DirFile {
  name: string;
  kind: string;
  size: number;
}

/** Everything the rules are allowed to know about one directory. */
export interface DirFacts {
  relPath: string;
  /** Non-missing files directly inside, ordered by name. */
  files: DirFile[];
  /** Names of the immediate subdirectories. */
  childNames: string[];
  /** Archive names in the *parent* directory: `foo/` beside `foo.zip`. */
  siblingArchives: string[];
}

/** A rule's verdict, with the figures a bundle row carries. */
export interface Match {
  type: BundleType;
  rule: string;
  memberCount: number;
  totalSize: number;
}

/** A verdict before the directory's own files are counted in. */
type Shape = Omit<Match, 'memberCount' | 'totalSize'>;

export function hasLeadingNumber(name: string): boolean {
  return LEADING_NUMBER.test(name);
}

export function hasSequenceMarker(name: string): boolean {
  return hasLeadingNumber(name) || SEQUENCE_KEYWORD.test(name);
}

/** True when `count` of `total` is at least `percent` per cent. */
export function atLeastPercent(total: number, percent: number, count: number): boolean {
  return total > 0 && count * 100 >= total * percent;
}

export function isProjectMarker(name: string): boolean {
  return PROJECT_MARKERS.has(name) || PROJECT_EXTENSIONS.has(extensionOf(name));
}

export function basenameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

/**
 * The walk-stopping rules, decided from names alone. `.git` wins over any
 * project marker: a repository is the more specific unit. Member count and size
 * are null because the contents are never catalogued, so they cannot be known.
 */
export function codeBundleFor(names: readonly string[]): Shape | null {
  if (names.includes('.git')) {
    return { type: 'code_repo', rule: 'contains .git' };
  }
  // Names arrive in directory order, which the filesystem chooses. Sort the
  // matching markers so the same tree always records the same rule text.
  const markers = names.filter((name) => isProjectMarker(name)).sort();
  const marker = markers[0];
  if (marker === undefined) return null;
  return { type: 'code_project', rule: `contains ${marker}` };
}

interface MediaMembers {
  videos: string[];
  audios: string[];
  images: string[];
  fileCount: number;
  totalSize: number;
}

function mediaMembers(files: DirFile[]): MediaMembers {
  const videos: string[] = [];
  const audios: string[] = [];
  const images: string[] = [];
  let totalSize = 0;
  for (const file of files) {
    totalSize += file.size;
    switch (file.kind) {
      case 'video':
        videos.push(file.name);
        break;
      case 'audio':
        audios.push(file.name);
        break;
      case 'image':
        images.push(file.name);
        break;
      default:
        break;
    }
  }
  return { videos, audios, images, fileCount: files.length, totalSize };
}

/** `course`: ≥3 videos directly inside, ≥60% carrying a sequence marker. */
function courseMatch(videos: string[]): Shape | null {
  if (videos.length < MIN_COURSE_VIDEOS) return null;
  const marked = videos.filter((name) => hasSequenceMarker(name)).length;
  if (!atLeastPercent(videos.length, SEQUENCE_PERCENT, marked)) return null;
  return {
    type: 'course',
    rule: `>=${MIN_COURSE_VIDEOS} videos, >=${SEQUENCE_PERCENT}% with a sequence marker`,
  };
}

/** `album`: ≥3 audio files directly inside, ≥60% with a leading track number. */
function albumMatch(audios: string[]): Shape | null {
  if (audios.length < MIN_ALBUM_TRACKS) return null;
  const numbered = audios.filter((name) => hasLeadingNumber(name)).length;
  if (!atLeastPercent(audios.length, SEQUENCE_PERCENT, numbered)) return null;
  return {
    type: 'album',
    rule: `>=${MIN_ALBUM_TRACKS} audio files, >=${SEQUENCE_PERCENT}% with a leading track number`,
  };
}

/** `photo_set`: ≥10 images directly inside, and images ≥70% of its files. */
function photoSetMatch(images: string[], fileCount: number): Shape | null {
  if (images.length < MIN_PHOTO_IMAGES) return null;
  if (!atLeastPercent(fileCount, IMAGE_PERCENT, images.length)) return null;
  return {
    type: 'photo_set',
    rule: `>=${MIN_PHOTO_IMAGES} images, images >=${IMAGE_PERCENT}% of its files`,
  };
}

/**
 * `extracted_archive`: a sibling archive whose stem is the directory's own
 * name (`foo/` beside `foo.zip`). The archive lives in the parent directory — the
 * extracted files are what is inside this one.
 */
function extractedArchiveMatch(dirName: string, siblingArchives: string[]): Shape | null {
  const archive = siblingArchives.find((name) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 && name.slice(0, dot) === dirName;
  });
  if (archive === undefined) return null;
  return { type: 'extracted_archive', rule: `sibling archive ${archive}` };
}

/**
 * A directory's own bundle, with precedence applied (plan Task 3):
 * `course` > `album` > `photo_set` > `extracted_archive`. The walk-stopping
 * types never reach here — they have no catalogued contents to count.
 *
 * Counts and size cover every file in the directory, not just the media that
 * triggered the rule: a bundle is the whole directory.
 */
export function matchFor(facts: DirFacts): Match | null {
  const members = mediaMembers(facts.files);
  const shape =
    courseMatch(members.videos) ??
    albumMatch(members.audios) ??
    photoSetMatch(members.images, members.fileCount) ??
    extractedArchiveMatch(basenameOf(facts.relPath), facts.siblingArchives);
  if (shape === null) return null;
  return { ...shape, memberCount: members.fileCount, totalSize: members.totalSize };
}

/**
 * `course` parent: ≥2 immediate subdirectories are course bundles, and ≥60% of
 * the subdirectory names carry a sequence marker.
 *
 * The counts aggregate the adopted modules, not the parent's own files: a
 * parent's loose files belong to no module, and folding them in would double
 * them into a total that no longer matches any directory.
 */
export function courseParentMatch(childNames: string[], children: Match[]): Match | null {
  if (children.length < MIN_PARENT_COURSE_DIRS) return null;
  const marked = childNames.filter((name) => hasSequenceMarker(name)).length;
  if (!atLeastPercent(childNames.length, SEQUENCE_PERCENT, marked)) return null;

  return {
    type: 'course',
    rule: `>=${MIN_PARENT_COURSE_DIRS} course subdirectories, >=${SEQUENCE_PERCENT}% of subdirectory names numbered`,
    memberCount: children.reduce((total, child) => total + child.memberCount, 0),
    totalSize: children.reduce((total, child) => total + child.totalSize, 0),
  };
}

export function depthOf(relPath: string): number {
  return relPath === '' ? 0 : relPath.split('/').length;
}