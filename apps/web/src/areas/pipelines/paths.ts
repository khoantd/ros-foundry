// Pipelines area URLs, merged into `paths` (apps/web/src/paths.ts). Owned by
// the pipelines area; do not import ../../paths here (it imports this file).
const enc = encodeURIComponent;
export const pipelinePaths = {
  pipelines: () => "/pipelines",
  pipeline: (id: string) => "/pipelines/" + enc(id),
  pipelineNew: () => "/pipelines/new",
  pipelineEdit: (id: string) => "/pipelines/" + enc(id) + "/edit",
};
