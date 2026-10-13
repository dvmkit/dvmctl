/** Public builder API data transfer objects. */
export type DeployStatus = "pending" | "building" | "release_accepted" | "recovering" | "deployed" | "failed" | "superseded";
export type DvmStatus = "created" | "deploying" | "deployed" | "deploy_failed" | "destroyed" | "suspended";
export type DvmRuntime = "container" | "isolate";
export type DomainStatus = "pending" | "verified" | "failed" | "revoked";
export type SuspensionReason = "request_limit" | "dvm_limit" | "behaviour" | "free_tier_idle" | "admin_org_suspend" | "builder_pause" | "withdrawn";
export interface VmConfig { memoryMb?: number; cpuCount?: number; cpuKind?: "shared" | "performance"; minMachinesRunning?: number; maxMachines?: number; }
export interface ResolvedVmConfig { memoryMb: number; cpuCount: number; cpuKind: "shared" | "performance"; minMachinesRunning: number; maxMachines: number; }
export interface Plan { name: string; maxMemoryMb: number | null; maxMachines: number | null; maxCpuCount: number | null; allowsPerformanceCpu: boolean; }
export interface Builder { id: string; email: string | null; handle: string | null; displayName: string | null; }
export interface Domain { id: string; dvmId: string | null; domain: string; status: DomainStatus; verificationAttemptedAt: number | null; createdAt: number; updatedAt: number; }
export interface DvmEventEntry { type: string; timestamp: number; actor: string | null; source: "deploy" | "audit" | "machine"; details: Record<string, unknown>; }
export interface RequestMetric { dvmId: string; hour: number; status2xx: number; status4xx: number; status5xx: number; totalRequests: number; totalLatencyMs: number; egressBytes: number; }
export interface BuilderDvmWithRevenue { id: string; orgId: string; slug: string; name: string; url: string | null; dvmkitUrl: string | null; status: DvmStatus; runtime: DvmRuntime; hidden: boolean; region: string; suspensionReason: SuspensionReason | null; pausedAt: number | null; githubRepoFullName: string | null; gitBranch: string | null; rootDir: string | null; entrypoint: string | null; endpointUrl: string | null; lastJobAt: number | null; feedbackEnabled: boolean; vmConfig?: ResolvedVmConfig | null; createdAt: number; updatedAt: number; lifetimeRevenueFiatMinor: number; dvmMeta: Record<string, unknown> | null; }
export interface BuilderDeploy { id: string; dvmId: string; status: DeployStatus; error: string | null; logs: string | null; startedAt: number; endedAt: number | null; trigger: string | null; commitSha: string | null; commitRef: string | null; commitMessage: string | null; commitAuthorName: string | null; }
export interface Deploy { id: string; dvmId: string; status: DeployStatus; error: string | null; startedAt: number; endedAt: number | null; releaseAcceptedAt: number | null; recoveryStatus: "attempting" | "succeeded" | "failed" | "superseded" | null; }
