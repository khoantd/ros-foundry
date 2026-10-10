import { describe, it, expect } from "vitest";
import {
  isBuildActive,
  latestPipelineBuild,
  mergeBuildJobs,
  pipelineBuildJobs,
  type BuildJobLike,
} from "../apps/web/src/areas/pipelines/build-status.js";

const job = (
  id: string,
  pipelineId: string,
  status: string,
  updatedAt: string,
  type = "pipeline",
): BuildJobLike => ({
  id,
  updatedAt,
  data: { type, pipelineId, status },
});

describe("pipeline build status", () => {
  it("filters and sorts pipeline builds newest first", () => {
    const jobs = [
      job("a", "p1", "succeeded", "2026-01-01T10:00:00.000Z"),
      job("b", "p1", "running", "2026-01-01T12:00:00.000Z"),
      job("c", "p2", "queued", "2026-01-01T13:00:00.000Z"),
      job("d", "p1", "failed", "2026-01-01T11:00:00.000Z", "sync"),
    ];
    expect(pipelineBuildJobs(jobs, "p1").map((j) => j.id)).toEqual(["b", "a"]);
    expect(latestPipelineBuild(jobs, "p1")?.id).toBe("b");
    expect(latestPipelineBuild(jobs, "missing")).toBeNull();
  });

  it("treats queued and running as active", () => {
    expect(isBuildActive(job("a", "p1", "queued", "t"))).toBe(true);
    expect(isBuildActive(job("a", "p1", "running", "t"))).toBe(true);
    expect(isBuildActive(job("a", "p1", "succeeded", "t"))).toBe(false);
    expect(isBuildActive(null)).toBe(false);
  });

  it("merges live and stored jobs by id, keeping the newer copy", () => {
    const stored = [job("a", "p1", "queued", "2026-01-01T10:00:00.000Z")];
    const live = [job("a", "p1", "running", "2026-01-01T10:00:01.000Z")];
    const merged = mergeBuildJobs(stored, live);
    expect(merged).toHaveLength(1);
    expect(merged[0].data.status).toBe("running");
  });
});
