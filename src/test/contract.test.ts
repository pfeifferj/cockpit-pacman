/**
 * Contract tests: verify that the frontend correctly handles JSON produced by the Rust backend.
 *
 * Each test parses a shared fixture from test/fixtures/ through the same code path the app uses
 * (cockpit.spawn → JSON.parse → cast as T). Failures here mean a TypeScript interface drifted
 * from the backend output, or fixture data no longer matches actual backend shape.
 *
 * Documented drifts (existing mismatches between Rust and TypeScript):
 *  1. PackageDetails.build_date: Rust always emits i64 (never null), TS types it as number|null.
 *  2. PackageSecurityAdvisory.fixed_version: Rust uses skip_serializing_if, so the field is
 *     ABSENT when no fix exists. TS types it as string|null — it should be string|null|undefined
 *     or use the optional `?:` marker. Accessing .fixed_version on an unfixed advisory yields
 *     undefined, not null.
 *  3. StreamEventEvent.package: Rust serializes Option<String> WITHOUT skip_serializing_if, so
 *     the field is always present in JSON — null when the event has no package. TypeScript types
 *     it as `package?: string` (optional, possibly absent), but it will never be absent from
 *     backend output. Code that checks `event.package === undefined` will always be false.
 *  4. StreamEventComplete.message: Same pattern — Rust always emits the field as null when there
 *     is no message. TypeScript types it as `message?: string`, but it is always present as null,
 *     never absent. Code that checks `complete.message === undefined` will always be false.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockSpawn } from "./setup";
import { createMockSpawnPromise } from "./mocks";
import type {
  PackageListResponse,
  Package,
  UpdatesResponse,
  UpdateInfo,
  PackageDetails,
  MirrorEntry,
  SecurityResponse,
  PackageSecurityAdvisory,
  LogGroup,
  LogEntry,
  RebootStatus,
  StreamEvent,
  StreamEventLog,
  StreamEventProgress,
  StreamEventDownload,
  StreamEventEvent,
  StreamEventComplete,
  StreamEventMirrorTest,
  MirrorTestResult,
  OrphanPackage,
  SecurityInfoResponse,
  SecurityInfoAdvisory,
  NewsItem,
  NewsResponse,
  ScheduledRunEntry,
} from "../api";
import {
  listInstalled,
  checkUpdates,
  getPackageInfo,
  searchPackages,
  preflightUpgrade,
  listMirrors,
  fetchMirrorStatus,
  checkSecurity,
  getGroupedHistory,
  getRebootStatus,
  getCacheInfo,
  getKeyringStatus,
  getDependencyTree,
  listOrphans,
  saveMirrorlist,
  refreshMirrors,
  restoreMirrorBackup,
  getSecurityInfo,
  fetchNews,
  getScheduledRuns,
  getSyncPackageInfo,
  listRepoMirrors,
} from "../api";

// JSON fixtures — vitest resolves these at build time via Vite's JSON import support
import packageListFixture from "../../test/fixtures/package-list.json";
import packageDetailFixture from "../../test/fixtures/package-detail.json";
import updatesFixture from "../../test/fixtures/updates.json";
import searchResultsFixture from "../../test/fixtures/search-results.json";
import preflightFixture from "../../test/fixtures/preflight.json";
import preflightWithDataFixture from "../../test/fixtures/preflight-with-data.json";
import mirrorListFixture from "../../test/fixtures/mirror-list.json";
import mirrorStatusFixture from "../../test/fixtures/mirror-status.json";
import securityFixture from "../../test/fixtures/security-advisories.json";
import logHistoryFixture from "../../test/fixtures/log-history.json";
import rebootStatusFixture from "../../test/fixtures/reboot-status.json";
import cacheInfoFixture from "../../test/fixtures/cache-info.json";
import keyringStatusFixture from "../../test/fixtures/keyring-status.json";
import dependencyTreeFixture from "../../test/fixtures/dependency-tree.json";
import streamEventsFixture from "../../test/fixtures/stream-events.json";
import orphansFixture from "../../test/fixtures/orphans.json";
import saveMirrorlistFixture from "../../test/fixtures/save-mirrorlist.json";
import refreshMirrorsFixture from "../../test/fixtures/refresh-mirrors.json";
import restoreMirrorBackupFixture from "../../test/fixtures/restore-mirror-backup.json";
import securityInfoFixture from "../../test/fixtures/security-info.json";
import newsFixture from "../../test/fixtures/news.json";
import scheduledRunsFixture from "../../test/fixtures/scheduled-runs.json";
import syncPackageDetailFixture from "../../test/fixtures/sync-package-detail.json";
import repoMirrorsFixture from "../../test/fixtures/repo-mirrors.json";

function spawnReturns(data: unknown): void {
  mockSpawn.mockReturnValue(
    createMockSpawnPromise(JSON.stringify(data))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});


describe("listInstalled contract", () => {
  it("parses package-list fixture into PackageListResponse shape", async () => {
    spawnReturns(packageListFixture);
    const result = await listInstalled();

    expect(Array.isArray(result.packages)).toBe(true);
    expect(typeof result.total).toBe("number");
    expect(typeof result.total_explicit).toBe("number");
    expect(typeof result.total_dependency).toBe("number");
    expect(Array.isArray(result.repositories)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("package entries have correct field types", async () => {
    spawnReturns(packageListFixture);
    const result = await listInstalled();

    const pkg: Package = result.packages[0];
    expect(typeof pkg.name).toBe("string");
    expect(typeof pkg.version).toBe("string");
    expect(typeof pkg.installed_size).toBe("number");
    expect(typeof pkg.reason).toBe("string");
    expect(["explicit", "dependency"]).toContain(pkg.reason);
  });

  it("nullable package fields are null (not undefined) when missing", async () => {
    spawnReturns(packageListFixture);
    const result = await listInstalled();

    // Second package in fixture has all nullable fields set to null
    const nullablePkg: Package = result.packages[1];
    expect(nullablePkg.description).toBeNull();
    expect(nullablePkg.install_date).toBeNull();
    expect(nullablePkg.repository).toBeNull();
  });

  it("fixture total counts match package array length", async () => {
    spawnReturns(packageListFixture);
    const result = await listInstalled();
    expect(result.total).toBe(result.packages.length);
    expect(result.total_explicit + result.total_dependency).toBe(result.total);
  });
});


describe("checkUpdates contract", () => {
  it("parses updates fixture into UpdatesResponse shape", async () => {
    spawnReturns(updatesFixture);
    const result = await checkUpdates();

    expect(Array.isArray(result.updates)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("update entries have correct field types", async () => {
    spawnReturns(updatesFixture);
    const result = await checkUpdates();

    const update: UpdateInfo = result.updates[0];
    expect(typeof update.name).toBe("string");
    expect(typeof update.current_version).toBe("string");
    expect(typeof update.new_version).toBe("string");
    expect(typeof update.download_size).toBe("number");
    expect(typeof update.current_size).toBe("number");
    expect(typeof update.new_size).toBe("number");
    expect(typeof update.repository).toBe("string");
    // repository is non-optional in UpdateInfo
    expect(update.repository).not.toBeNull();
  });
});


describe("getPackageInfo contract", () => {
  it("parses package-detail fixture into PackageDetails shape", async () => {
    spawnReturns(packageDetailFixture);
    const result = await getPackageInfo("linux");

    expect(typeof result.name).toBe("string");
    expect(typeof result.version).toBe("string");
    expect(Array.isArray(result.licenses)).toBe(true);
    expect(Array.isArray(result.depends)).toBe(true);
    expect(Array.isArray(result.provides)).toBe(true);
    expect(typeof result.installed_size).toBe("number");
    expect(typeof result.reason).toBe("string");
  });

  it("DRIFT: build_date is always a number from backend, never null", async () => {
    // Rust: pub build_date: i64 — always serialized as integer
    // TypeScript: build_date: number | null — unnecessarily allows null
    // Practical impact: code that null-checks build_date before using it is dead code;
    // code that skips the null-check is safe and correct.
    spawnReturns(packageDetailFixture);
    const result = await getPackageInfo("linux");

    expect(typeof result.build_date).toBe("number");
    expect(result.build_date).not.toBeNull();
    expect(result.build_date).toBeGreaterThan(0);
  });

  it("optional fields are null when backend emits null", async () => {
    const withNulls = {
      ...packageDetailFixture,
      description: null,
      url: null,
      packager: null,
      architecture: null,
      install_date: null,
      repository: null,
      update_stats: null,
    };
    spawnReturns(withNulls);
    const result = await getPackageInfo("minimal");

    expect(result.description).toBeNull();
    expect(result.url).toBeNull();
    expect(result.packager).toBeNull();
    expect(result.architecture).toBeNull();
    expect(result.install_date).toBeNull();
    expect(result.repository).toBeNull();
    expect(result.update_stats).toBeNull();
  });

  it("update_stats nested object has correct field types when present", async () => {
    const withStats = {
      ...packageDetailFixture,
      update_stats: {
        update_count: 7,
        first_installed: "2022-01-01",
        last_updated: "2024-01-01",
        avg_days_between_updates: 91.5,
      },
    };
    spawnReturns(withStats);
    const result = await getPackageInfo("linux");

    expect(result.update_stats).not.toBeNull();
    expect(typeof result.update_stats!.update_count).toBe("number");
    expect(typeof result.update_stats!.avg_days_between_updates).toBe("number");
    expect(typeof result.update_stats!.first_installed).toBe("string");
  });

  it("all required array fields are always present (never absent)", async () => {
    spawnReturns(packageDetailFixture);
    const result = await getPackageInfo("linux");

    const arrayFields: (keyof PackageDetails)[] = [
      "licenses", "groups", "provides", "depends",
      "optdepends", "conflicts", "replaces",
      "required_by", "optional_for", "validation",
    ];
    for (const field of arrayFields) {
      expect(Array.isArray(result[field]), `${field} must be an array`).toBe(true);
    }
  });
});


describe("searchPackages contract", () => {
  it("parses search-results fixture into SearchResponse shape", async () => {
    spawnReturns(searchResultsFixture);
    const result = await searchPackages({ query: "linux" });

    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.total).toBe("number");
    expect(typeof result.total_installed).toBe("number");
    expect(typeof result.total_not_installed).toBe("number");
    expect(Array.isArray(result.repositories)).toBe(true);
  });

  it("installed package has installed_version string, not-installed has null", async () => {
    spawnReturns(searchResultsFixture);
    const result = await searchPackages({ query: "linux" });

    const installed = result.results.find((r) => r.installed);
    const notInstalled = result.results.find((r) => !r.installed);

    expect(installed).toBeDefined();
    expect(typeof installed!.installed_version).toBe("string");

    expect(notInstalled).toBeDefined();
    expect(notInstalled!.installed_version).toBeNull();
  });

  it("total_installed + total_not_installed equals total", async () => {
    spawnReturns(searchResultsFixture);
    const result = await searchPackages({ query: "linux" });
    expect(result.total_installed + result.total_not_installed).toBe(result.total);
  });
});


describe("preflightUpgrade contract", () => {
  it("minimal fixture (empty arrays absent) parses correctly", async () => {
    spawnReturns(preflightFixture);
    const result = await preflightUpgrade();

    expect(typeof result.success).toBe("boolean");
    expect(typeof result.packages_to_upgrade).toBe("number");
    expect(typeof result.total_download_size).toBe("number");
  });

  it("absent optional arrays become undefined (not null) in parsed result", async () => {
    // Rust uses skip_serializing_if = "Vec::is_empty", so empty arrays are ABSENT.
    // TS interface uses ?:, so they are undefined when absent — correct.
    spawnReturns(preflightFixture);
    const result = await preflightUpgrade();

    expect(result.conflicts).toBeUndefined();
    expect(result.replacements).toBeUndefined();
    expect(result.removals).toBeUndefined();
    expect(result.providers).toBeUndefined();
    expect(result.import_keys).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("fixture with all optional arrays present parses correctly", async () => {
    spawnReturns(preflightWithDataFixture);
    const result = await preflightUpgrade();

    expect(Array.isArray(result.conflicts)).toBe(true);
    expect(Array.isArray(result.replacements)).toBe(true);
    expect(Array.isArray(result.removals)).toBe(true);
    expect(Array.isArray(result.providers)).toBe(true);
    expect(Array.isArray(result.import_keys)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("conflict has package1 and package2 fields", async () => {
    spawnReturns(preflightWithDataFixture);
    const result = await preflightUpgrade();

    const conflict = result.conflicts![0];
    expect(typeof conflict.package1).toBe("string");
    expect(typeof conflict.package2).toBe("string");
  });

  it("replacement has old_package and new_package fields", async () => {
    spawnReturns(preflightWithDataFixture);
    const result = await preflightUpgrade();

    const replacement = result.replacements![0];
    expect(typeof replacement.old_package).toBe("string");
    expect(typeof replacement.new_package).toBe("string");
  });

  it("warning severity is one of the expected lowercase values", async () => {
    spawnReturns(preflightWithDataFixture);
    const result = await preflightUpgrade();

    const warning = result.warnings![0];
    expect(typeof warning.id).toBe("string");
    expect(["info", "warning", "danger"]).toContain(warning.severity);
    expect(typeof warning.title).toBe("string");
    expect(typeof warning.message).toBe("string");
    expect(Array.isArray(warning.packages)).toBe(true);
  });

  it("key import has fingerprint and uid fields", async () => {
    spawnReturns(preflightWithDataFixture);
    const result = await preflightUpgrade();

    const key = result.import_keys![0];
    expect(typeof key.fingerprint).toBe("string");
    expect(typeof key.uid).toBe("string");
  });
});


describe("listMirrors contract", () => {
  it("parses mirror-list fixture into MirrorListResponse shape", async () => {
    spawnReturns(mirrorListFixture);
    const result = await listMirrors();

    expect(Array.isArray(result.mirrors)).toBe(true);
    expect(typeof result.total).toBe("number");
    expect(typeof result.enabled_count).toBe("number");
    expect(typeof result.path).toBe("string");
  });

  it("mirror entry has required fields with correct types", async () => {
    spawnReturns(mirrorListFixture);
    const result = await listMirrors();

    const mirror: MirrorEntry = result.mirrors[0];
    expect(typeof mirror.url).toBe("string");
    expect(typeof mirror.enabled).toBe("boolean");
  });

  it("mirror comment is null when absent, string when present", async () => {
    spawnReturns(mirrorListFixture);
    const result = await listMirrors();

    const withoutComment = result.mirrors[0];
    expect(withoutComment.comment).toBeNull();

    const withComment = result.mirrors[1];
    expect(typeof withComment.comment).toBe("string");
  });

  it("last_modified is a number (unix timestamp) or null", async () => {
    spawnReturns(mirrorListFixture);
    const result = await listMirrors();
    expect(typeof result.last_modified).toBe("number");

    spawnReturns({ ...mirrorListFixture, last_modified: null });
    const withNull = await listMirrors();
    expect(withNull.last_modified).toBeNull();
  });
});


describe("listRepoMirrors contract", () => {
  it("parses repo-mirrors fixture into RepoMirrorsResponse shape", async () => {
    spawnReturns(repoMirrorsFixture);
    const result = await listRepoMirrors();

    expect(Array.isArray(result.repos)).toBe(true);
    expect(result.repos.length).toBe(3);
  });

  it("each repo has name and directives array", async () => {
    spawnReturns(repoMirrorsFixture);
    const result = await listRepoMirrors();

    for (const repo of result.repos) {
      expect(typeof repo.name).toBe("string");
      expect(Array.isArray(repo.directives)).toBe(true);
      for (const d of repo.directives) {
        expect(["Server", "Include"]).toContain(d.directive_type);
        expect(typeof d.value).toBe("string");
      }
    }
  });

  it("handles empty repos list", async () => {
    spawnReturns({ repos: [] });
    const result = await listRepoMirrors();

    expect(result.repos).toEqual([]);
  });
});


describe("fetchMirrorStatus contract", () => {
  it("parses mirror-status fixture into MirrorStatusResponse shape", async () => {
    spawnReturns(mirrorStatusFixture);
    const result = await fetchMirrorStatus();

    expect(Array.isArray(result.mirrors)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  it("mirror status entry optional fields are null when absent from backend", async () => {
    spawnReturns(mirrorStatusFixture);
    const result = await fetchMirrorStatus();

    // Second mirror in fixture has all optional fields null
    const sparse = result.mirrors[1];
    expect(sparse.last_sync).toBeNull();
    expect(sparse.delay).toBeNull();
    expect(sparse.score).toBeNull();
    expect(sparse.completion_pct).toBeNull();
    expect(sparse.country).not.toBeNull(); // country IS present in fixture
  });

  it("populated mirror status entry has number fields", async () => {
    spawnReturns(mirrorStatusFixture);
    const result = await fetchMirrorStatus();

    const populated = result.mirrors[0];
    expect(typeof populated.delay).toBe("number");
    expect(typeof populated.score).toBe("number");
    expect(typeof populated.completion_pct).toBe("number");
    expect(typeof populated.active).toBe("boolean");
    expect(typeof populated.ipv4).toBe("boolean");
    expect(typeof populated.ipv6).toBe("boolean");
  });
});


describe("checkSecurity contract", () => {
  it("parses security-advisories fixture into SecurityResponse shape", async () => {
    spawnReturns(securityFixture);
    const result = await checkSecurity();

    expect(Array.isArray(result.advisories)).toBe(true);
  });

  it("advisory has expected string fields", async () => {
    spawnReturns(securityFixture);
    const result = await checkSecurity();

    const advisory: PackageSecurityAdvisory = result.advisories[0];
    expect(typeof advisory.package).toBe("string");
    expect(typeof advisory.severity).toBe("string");
    expect(typeof advisory.advisory_type).toBe("string");
    expect(typeof advisory.avg_name).toBe("string");
    expect(Array.isArray(advisory.cve_ids)).toBe(true);
    expect(typeof advisory.status).toBe("string");
  });

  it("DRIFT: fixed_version is undefined (not null) when backend omits it via skip_serializing_if", async () => {
    // Rust: #[serde(skip_serializing_if = "Option::is_none")] on fixed_version
    // Result: field is ABSENT in JSON when no fix exists
    // TypeScript: types it as `string | null` — but accessing it yields `undefined`
    // Fix needed: TS interface should use `fixed_version?: string | null`
    spawnReturns(securityFixture);
    const result = await checkSecurity();

    const unfixedAdvisory = result.advisories[0]; // no fixed_version in fixture
    expect((unfixedAdvisory as unknown as Record<string, unknown>)["fixed_version"]).toBeUndefined();
    // This is the drift: the TS type says string|null but the actual value is undefined
    expect(unfixedAdvisory.fixed_version).toBeUndefined();
  });

  it("fixed_version is present when backend includes it", async () => {
    spawnReturns(securityFixture);
    const result = await checkSecurity();

    const fixedAdvisory = result.advisories[1]; // has fixed_version in fixture
    expect(typeof fixedAdvisory.fixed_version).toBe("string");
    expect(fixedAdvisory.fixed_version).toBe("8.5.0-1");
  });
});


describe("getGroupedHistory contract", () => {
  it("parses log-history fixture into GroupedLogResponse shape", async () => {
    spawnReturns(logHistoryFixture);
    const result = await getGroupedHistory();

    expect(Array.isArray(result.groups)).toBe(true);
    expect(typeof result.total_groups).toBe("number");
    expect(typeof result.total_upgraded).toBe("number");
    expect(typeof result.total_installed).toBe("number");
    expect(typeof result.total_removed).toBe("number");
    expect(typeof result.total_other).toBe("number");
  });

  it("log group has all required count fields", async () => {
    spawnReturns(logHistoryFixture);
    const result = await getGroupedHistory();

    const group: LogGroup = result.groups[0];
    expect(typeof group.id).toBe("string");
    expect(typeof group.start_time).toBe("string");
    expect(typeof group.end_time).toBe("string");
    expect(Array.isArray(group.entries)).toBe(true);
    expect(typeof group.upgraded_count).toBe("number");
    expect(typeof group.installed_count).toBe("number");
    expect(typeof group.removed_count).toBe("number");
    expect(typeof group.downgraded_count).toBe("number");
    expect(typeof group.reinstalled_count).toBe("number");
  });

  it("log entry old_version and new_version are null for install/remove actions", async () => {
    spawnReturns(logHistoryFixture);
    const result = await getGroupedHistory();

    const group = result.groups[1]; // group with install+remove
    const installed: LogEntry = group.entries[0];
    expect(typeof installed.action).toBe("string");
    expect(installed.old_version).toBeNull();
    expect(typeof installed.new_version).toBe("string");

    const removed: LogEntry = group.entries[1];
    expect(typeof removed.old_version).toBe("string");
    expect(removed.new_version).toBeNull();
  });

  it("upgraded entry has both old_version and new_version", async () => {
    spawnReturns(logHistoryFixture);
    const result = await getGroupedHistory();

    const group = result.groups[0];
    const upgraded: LogEntry = group.entries[0];
    expect(upgraded.action).toBe("upgraded");
    expect(typeof upgraded.old_version).toBe("string");
    expect(typeof upgraded.new_version).toBe("string");
  });
});


describe("getRebootStatus contract", () => {
  it("parses reboot-status fixture into RebootStatus shape", async () => {
    spawnReturns(rebootStatusFixture);
    const result = await getRebootStatus();

    expect(typeof result.requires_reboot).toBe("boolean");
    expect(typeof result.reason).toBe("string");
    expect(Array.isArray(result.updated_packages)).toBe(true);
  });

  it("kernel fields are strings when present", async () => {
    spawnReturns(rebootStatusFixture);
    const result = await getRebootStatus();

    expect(typeof result.running_kernel).toBe("string");
    expect(typeof result.installed_kernel).toBe("string");
    expect(typeof result.kernel_package).toBe("string");
  });

  it("kernel fields are null when no reboot required", async () => {
    const noReboot: RebootStatus = {
      requires_reboot: false,
      reason: "none",
      running_kernel: null,
      installed_kernel: null,
      kernel_package: null,
      updated_packages: [],
    };
    spawnReturns(noReboot);
    const result = await getRebootStatus();

    expect(result.requires_reboot).toBe(false);
    expect(result.running_kernel).toBeNull();
    expect(result.installed_kernel).toBeNull();
    expect(result.kernel_package).toBeNull();
  });
});


describe("getCacheInfo contract", () => {
  it("parses cache-info fixture into CacheInfo shape", async () => {
    spawnReturns(cacheInfoFixture);
    const result = await getCacheInfo();

    expect(typeof result.total_size).toBe("number");
    expect(typeof result.package_count).toBe("number");
    expect(Array.isArray(result.packages)).toBe(true);
    expect(typeof result.path).toBe("string");
  });

  it("cache package entries have all required fields", async () => {
    spawnReturns(cacheInfoFixture);
    const result = await getCacheInfo();

    const pkg = result.packages[0];
    expect(typeof pkg.name).toBe("string");
    expect(typeof pkg.version).toBe("string");
    expect(typeof pkg.filename).toBe("string");
    expect(typeof pkg.size).toBe("number");
  });
});


describe("getKeyringStatus contract", () => {
  it("parses keyring-status fixture into KeyringStatusResponse shape", async () => {
    spawnReturns(keyringStatusFixture);
    const result = await getKeyringStatus();

    expect(Array.isArray(result.keys)).toBe(true);
    expect(typeof result.total).toBe("number");
    expect(typeof result.master_key_initialized).toBe("boolean");
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("key entries have required fields and nullable created/expires", async () => {
    spawnReturns(keyringStatusFixture);
    const result = await getKeyringStatus();

    const firstKey = result.keys[0];
    expect(typeof firstKey.fingerprint).toBe("string");
    expect(typeof firstKey.uid).toBe("string");
    expect(typeof firstKey.trust).toBe("string");
    expect(typeof firstKey.created).toBe("string"); // present in first key
    expect(firstKey.expires).toBeNull(); // null in first key

    const secondKey = result.keys[1];
    expect(typeof secondKey.expires).toBe("string"); // present in second key
  });
});


describe("getDependencyTree contract", () => {
  it("parses dependency-tree fixture into DependencyTreeResponse shape", async () => {
    spawnReturns(dependencyTreeFixture);
    const result = await getDependencyTree({ name: "linux" });

    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(typeof result.root).toBe("string");
    expect(typeof result.max_depth_reached).toBe("boolean");
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("dependency nodes have required fields and nullable reason/repository", async () => {
    spawnReturns(dependencyTreeFixture);
    const result = await getDependencyTree({ name: "linux" });

    const rootNode = result.nodes[0];
    expect(typeof rootNode.id).toBe("string");
    expect(typeof rootNode.name).toBe("string");
    expect(typeof rootNode.version).toBe("string");
    expect(typeof rootNode.depth).toBe("number");
    expect(typeof rootNode.installed).toBe("boolean");
    expect(typeof rootNode.reason).toBe("string"); // "explicit" for root
    expect(typeof rootNode.repository).toBe("string");

    // Third node in fixture has null reason and repository
    const deepNode = result.nodes[2];
    expect(deepNode.reason).toBeNull();
    expect(deepNode.repository).toBeNull();
  });

  it("dependency edges have source, target, and edge_type", async () => {
    spawnReturns(dependencyTreeFixture);
    const result = await getDependencyTree({ name: "linux" });

    const edge = result.edges[0];
    expect(typeof edge.source).toBe("string");
    expect(typeof edge.target).toBe("string");
    expect(typeof edge.edge_type).toBe("string");
  });
});


describe("stream-events fixture shape", () => {
  // These tests verify the fixture file — the actual streaming path is tested in api.test.ts.
  // Here we confirm the fixture events have the correct shape for each discriminated type.

  const events = streamEventsFixture as StreamEvent[];

  it("all events have a string type discriminant", () => {
    for (const event of events) {
      expect(typeof event.type).toBe("string");
    }
  });

  it("log event has level and message strings", () => {
    const logEvent = events.find((e) => e.type === "log") as StreamEventLog | undefined;
    expect(logEvent).toBeDefined();
    expect(typeof logEvent!.level).toBe("string");
    expect(typeof logEvent!.message).toBe("string");
  });

  it("progress event has operation, package, percent, current, total", () => {
    const progressEvent = events.find(
      (e) => e.type === "progress"
    ) as StreamEventProgress | undefined;
    expect(progressEvent).toBeDefined();
    expect(typeof progressEvent!.operation).toBe("string");
    expect(typeof progressEvent!.package).toBe("string");
    expect(typeof progressEvent!.percent).toBe("number");
    expect(typeof progressEvent!.current).toBe("number");
    expect(typeof progressEvent!.total).toBe("number");
  });

  it("download event with optional downloaded/total fields — absent in 'started' variant", () => {
    const startedDownload = events.find(
      (e) => e.type === "download" && (e as StreamEventDownload).event === "started"
    ) as StreamEventDownload | undefined;
    expect(startedDownload).toBeDefined();
    expect(typeof startedDownload!.filename).toBe("string");
    // downloaded and total are absent (skip_serializing_if) in the "started" event
    expect((startedDownload as unknown as Record<string, unknown>)["downloaded"]).toBeUndefined();
    expect((startedDownload as unknown as Record<string, unknown>)["total"]).toBeUndefined();
  });

  it("download event 'progress' variant has downloaded and total as numbers", () => {
    const progressDownload = events.find(
      (e) => e.type === "download" && (e as StreamEventDownload).event === "progress"
    ) as StreamEventDownload | undefined;
    expect(progressDownload).toBeDefined();
    expect(typeof progressDownload!.downloaded).toBe("number");
    expect(typeof progressDownload!.total).toBe("number");
  });

  it("event with no package has package: null (not absent)", () => {
    const transactionDone = events.find(
      (e) => e.type === "event" && (e as StreamEventEvent).event === "transaction_done"
    ) as StreamEventEvent | undefined;
    expect(transactionDone).toBeDefined();
    // Rust: package: Option<String> with no skip_serializing_if → null when None
    expect((transactionDone as unknown as Record<string, unknown>)["package"]).toBeNull();
  });

  it("complete event has success bool and message (null when absent)", () => {
    const completeEvent = events.find(
      (e) => e.type === "complete"
    ) as StreamEventComplete | undefined;
    expect(completeEvent).toBeDefined();
    expect(typeof completeEvent!.success).toBe("boolean");
    // message: Option<String> with no skip_serializing_if → null when None
    expect((completeEvent as unknown as Record<string, unknown>)["message"]).toBeNull();
  });

  it("mirror_test event has nested result object with correct shape", () => {
    const mirrorTestEvent = (events as unknown as StreamEventMirrorTest[]).find(
      (e) => e.type === "mirror_test"
    );
    expect(mirrorTestEvent).toBeDefined();
    expect(typeof mirrorTestEvent!.url).toBe("string");
    expect(typeof mirrorTestEvent!.current).toBe("number");
    expect(typeof mirrorTestEvent!.total).toBe("number");

    const result: MirrorTestResult = mirrorTestEvent!.result;
    expect(typeof result.url).toBe("string");
    expect(typeof result.success).toBe("boolean");
  });

  it("failed mirror_test has null speed_bps, latency_ms and a string error", () => {
    const failedTest = (events as unknown as StreamEventMirrorTest[]).find(
      (e) => e.type === "mirror_test" && !e.result.success
    );
    expect(failedTest).toBeDefined();
    const result = failedTest!.result;
    expect(result.speed_bps).toBeNull();
    expect(result.latency_ms).toBeNull();
    expect(typeof result.error).toBe("string");
  });
});


describe("listOrphans contract", () => {
  it("parses orphans fixture into OrphanResponse shape", async () => {
    spawnReturns(orphansFixture);
    const result = await listOrphans();

    expect(Array.isArray(result.orphans)).toBe(true);
    expect(typeof result.total_size).toBe("number");
  });

  it("orphan package entries have correct field types", async () => {
    spawnReturns(orphansFixture);
    const result = await listOrphans();

    const pkg: OrphanPackage = result.orphans[0];
    expect(typeof pkg.name).toBe("string");
    expect(typeof pkg.version).toBe("string");
    expect(typeof pkg.description).toBe("string");
    expect(typeof pkg.installed_size).toBe("number");
    expect(typeof pkg.install_date).toBe("number");
    expect(typeof pkg.repository).toBe("string");
  });

  it("nullable orphan fields are null when absent", async () => {
    spawnReturns(orphansFixture);
    const result = await listOrphans();

    const sparse: OrphanPackage = result.orphans[1];
    expect(sparse.description).toBeNull();
    expect(sparse.install_date).toBeNull();
    expect(sparse.repository).toBeNull();
  });
});


describe("saveMirrorlist contract", () => {
  it("parses save-mirrorlist fixture into SaveMirrorlistResponse shape", async () => {
    spawnReturns(saveMirrorlistFixture);
    const result = await saveMirrorlist([]);

    expect(typeof result.success).toBe("boolean");
    expect(typeof result.backup_path).toBe("string");
    expect(typeof result.message).toBe("string");
  });

  it("backup_path is null when no backup was created", async () => {
    spawnReturns({ ...saveMirrorlistFixture, backup_path: null });
    const result = await saveMirrorlist([]);
    expect(result.backup_path).toBeNull();
  });

  it("success false with null backup_path on failure", async () => {
    spawnReturns({ success: false, backup_path: null, message: "Failed to write" });
    const result = await saveMirrorlist([]);
    expect(result.success).toBe(false);
    expect(result.backup_path).toBeNull();
    expect(typeof result.message).toBe("string");
  });
});


describe("refreshMirrors contract", () => {
  it("parses refresh-mirrors fixture into RefreshMirrorsResponse shape", async () => {
    spawnReturns(refreshMirrorsFixture);
    const result = await refreshMirrors();

    expect(Array.isArray(result.mirrors)).toBe(true);
    expect(typeof result.total).toBe("number");
    expect(typeof result.last_check).toBe("string");
  });

  it("mirror entries in response have correct field types", async () => {
    spawnReturns(refreshMirrorsFixture);
    const result = await refreshMirrors();

    const m: MirrorEntry = result.mirrors[0];
    expect(typeof m.url).toBe("string");
    expect(typeof m.enabled).toBe("boolean");
    expect(m.comment).toBeNull();

    const withComment: MirrorEntry = result.mirrors[1];
    expect(typeof withComment.comment).toBe("string");
  });

  it("last_check is null when not available", async () => {
    spawnReturns({ ...refreshMirrorsFixture, last_check: null });
    const result = await refreshMirrors();
    expect(result.last_check).toBeNull();
  });
});


describe("restoreMirrorBackup contract", () => {
  it("parses restore-mirror-backup fixture into RestoreMirrorBackupResponse shape", async () => {
    spawnReturns(restoreMirrorBackupFixture);
    const result = await restoreMirrorBackup(1704067200);

    expect(typeof result.success).toBe("boolean");
    expect(typeof result.backup_path).toBe("string");
    expect(typeof result.message).toBe("string");
  });

  it("backup_path is null when unavailable", async () => {
    spawnReturns({ ...restoreMirrorBackupFixture, backup_path: null });
    const result = await restoreMirrorBackup(1704067200);
    expect(result.backup_path).toBeNull();
  });
});


describe("getSecurityInfo contract", () => {
  it("parses security-info fixture into SecurityInfoResponse shape", async () => {
    spawnReturns(securityInfoFixture);
    const result = await getSecurityInfo("openssl");

    expect(typeof result.name).toBe("string");
    expect(Array.isArray(result.advisories)).toBe(true);
    expect(Array.isArray(result.groups)).toBe(true);
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("advisory entries have correct field types", async () => {
    spawnReturns(securityInfoFixture);
    const result = await getSecurityInfo("openssl");

    const advisory: SecurityInfoAdvisory = result.advisories[0];
    expect(typeof advisory.name).toBe("string");
    expect(typeof advisory.date).toBe("string");
    expect(typeof advisory.severity).toBe("string");
    expect(typeof advisory.advisory_type).toBe("string");
  });

  it("issues have all required fields", async () => {
    spawnReturns(securityInfoFixture);
    const result = await getSecurityInfo("openssl");

    const issue = result.issues[0];
    expect(typeof issue.name).toBe("string");
    expect(typeof issue.severity).toBe("string");
    expect(typeof issue.issue_type).toBe("string");
    expect(typeof issue.status).toBe("string");
  });

  it("empty arrays are valid (package with no advisories)", async () => {
    spawnReturns({
      name: "safe-pkg",
      advisories: [],
      groups: [],
      issues: [],
    } as SecurityInfoResponse);
    const result = await getSecurityInfo("safe-pkg");

    expect(result.advisories).toHaveLength(0);
    expect(result.groups).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });
});


describe("fetchNews contract", () => {
  it("parses news fixture into NewsResponse shape", async () => {
    spawnReturns(newsFixture);
    const result = await fetchNews();

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("news items have all required string fields", async () => {
    spawnReturns(newsFixture);
    const result = await fetchNews();

    const item: NewsItem = result.items[0];
    expect(typeof item.title).toBe("string");
    expect(typeof item.link).toBe("string");
    expect(typeof item.published).toBe("string");
    expect(typeof item.summary).toBe("string");
  });

  it("empty items array is valid", async () => {
    spawnReturns({ items: [] } as NewsResponse);
    const result = await fetchNews();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(0);
  });
});


describe("getScheduledRuns contract", () => {
  it("parses scheduled-runs fixture into ScheduledRunsResponse shape", async () => {
    spawnReturns(scheduledRunsFixture);
    const result = await getScheduledRuns();

    expect(Array.isArray(result.runs)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  it("successful run has null error and populated details", async () => {
    spawnReturns(scheduledRunsFixture);
    const result = await getScheduledRuns();

    const successRun: ScheduledRunEntry = result.runs[0];
    expect(typeof successRun.timestamp).toBe("string");
    expect(typeof successRun.mode).toBe("string");
    expect(successRun.success).toBe(true);
    expect(typeof successRun.packages_checked).toBe("number");
    expect(typeof successRun.packages_upgraded).toBe("number");
    expect(successRun.error).toBeNull();
    expect(Array.isArray(successRun.details)).toBe(true);
  });

  it("failed run has string error and zero counts", async () => {
    spawnReturns(scheduledRunsFixture);
    const result = await getScheduledRuns();

    const failedRun: ScheduledRunEntry = result.runs[1];
    expect(failedRun.success).toBe(false);
    expect(typeof failedRun.error).toBe("string");
    expect(failedRun.packages_upgraded).toBe(0);
  });

  it("total matches runs array length in fixture", async () => {
    spawnReturns(scheduledRunsFixture);
    const result = await getScheduledRuns();
    expect(result.total).toBe(result.runs.length);
  });
});


describe("getSyncPackageInfo contract", () => {
  it("parses sync-package-detail fixture into SyncPackageDetails shape", async () => {
    spawnReturns(syncPackageDetailFixture);
    const result = await getSyncPackageInfo("linux");

    expect(typeof result.name).toBe("string");
    expect(typeof result.version).toBe("string");
    expect(typeof result.repository).toBe("string");
    expect(typeof result.download_size).toBe("number");
    expect(typeof result.installed_size).toBe("number");
    expect(typeof result.build_date).toBe("number");
    expect(Array.isArray(result.licenses)).toBe(true);
    expect(Array.isArray(result.depends)).toBe(true);
  });

  it("SyncPackageDetails has download_size, not install_date or reason", async () => {
    spawnReturns(syncPackageDetailFixture);
    const result = await getSyncPackageInfo("linux");

    expect(typeof result.download_size).toBe("number");
    // install_date and reason are not part of SyncPackageDetails
    expect((result as unknown as Record<string, unknown>)["install_date"]).toBeUndefined();
    expect((result as unknown as Record<string, unknown>)["reason"]).toBeUndefined();
  });

  it("nullable fields are null when absent from backend", async () => {
    spawnReturns({
      ...syncPackageDetailFixture,
      description: null,
      url: null,
      packager: null,
      architecture: null,
    });
    const result = await getSyncPackageInfo("linux");

    expect(result.description).toBeNull();
    expect(result.url).toBeNull();
    expect(result.packager).toBeNull();
    expect(result.architecture).toBeNull();
  });
});


describe("fixture files are valid JSON objects", () => {
  it("package-list.json is an object with packages array", () => {
    expect(packageListFixture).toBeDefined();
    expect(Array.isArray((packageListFixture as PackageListResponse).packages)).toBe(true);
  });

  it("package-detail.json is an object with a name field", () => {
    expect((packageDetailFixture as PackageDetails).name).toBeDefined();
    expect(typeof (packageDetailFixture as PackageDetails).name).toBe("string");
  });

  it("updates.json is an object with an updates array", () => {
    expect(Array.isArray((updatesFixture as UpdatesResponse).updates)).toBe(true);
  });

  it("security-advisories.json advisories array has entries with and without fixed_version", () => {
    const advisories = (securityFixture as SecurityResponse).advisories;
    const hasFixed = advisories.some(
      (a) => "fixed_version" in (a as unknown as Record<string, unknown>)
    );
    const lacksFixed = advisories.some(
      (a) => !("fixed_version" in (a as unknown as Record<string, unknown>))
    );
    expect(hasFixed).toBe(true);
    expect(lacksFixed).toBe(true);
  });
});
