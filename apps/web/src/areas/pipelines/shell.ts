import { Workflow } from "lucide-react";
import type { AreaShell } from "../../shell/types";
import { paths } from "../../paths";
import { relative } from "../../api";

// Sidebar palette entries for published pipelines.
export const pipelinesShell: AreaShell = {
  palette: [
    {
      id: "pipelines",
      label: "Pipelines",
      kind: "pipeline",
      icon: Workflow,
      href: (r) => paths.pipeline(r.id),
      subtitle: (r) =>
        [
          r.data.inputs?.length
            ? `${r.data.inputs.length} input${r.data.inputs.length === 1 ? "" : "s"}`
            : "",
          relative(r.updatedAt),
        ]
          .filter(Boolean)
          .join(" · "),
    },
  ],
};
