/** Slim job shape from resources/job or the live event stream. */
export type BuildJobLike = {
  id: string;
  updatedAt: string;
  data: {
    type?: string;
    pipelineId?: string;
    status?: string;
    error?: string | null;
  };
};

/** Prefer the newest copy of each job id (live stream can race the list). */
export function mergeBuildJobs(...lists: BuildJobLike[][]): BuildJobLike[] {
  const byId = new Map<string, BuildJobLike>();
  for (const list of lists) {
    for (const job of list) {
      const prev = byId.get(job.id);
      if (!prev || job.updatedAt >= prev.updatedAt) byId.set(job.id, job);
    }
  }
  return [...byId.values()];
}

/** Pipeline builds for one pipeline, newest first. */
export function pipelineBuildJobs(
  jobs: BuildJobLike[],
  pipelineId: string,
): BuildJobLike[] {
  return jobs
    .filter(
      (j) => j.data.type === "pipeline" && j.data.pipelineId === pipelineId,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function latestPipelineBuild(
  jobs: BuildJobLike[],
  pipelineId: string,
): BuildJobLike | null {
  return pipelineBuildJobs(jobs, pipelineId)[0] ?? null;
}

export function isBuildActive(job: BuildJobLike | null | undefined): boolean {
  const status = job?.data.status;
  return status === "queued" || status === "running";
}
