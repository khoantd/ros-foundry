import { Link } from "react-router-dom";
import { ChevronRight, Plus, Workflow } from "lucide-react";
import { relative } from "../../api";
import { paths } from "../../paths";
import { useWorkspace, useResources } from "../../ui";
import {
  ButtonLink,
  EmptyState,
  Page,
  PageHeader,
  SearchInput,
  Skeleton,
} from "../../kit";
import { useState } from "react";
import type { Resource } from "../../../../../packages/shared/src";

export function PipelinesList() {
  const { role } = useWorkspace();
  const pipelines = useResources("pipeline");
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const items = ((pipelines.data?.items || []) as Resource[]).filter(
    (p) =>
      !term ||
      p.name.toLowerCase().includes(term) ||
      (p.description || "").toLowerCase().includes(term),
  );
  const loading = pipelines.isPending;
  const empty = !loading && !(pipelines.data?.items || []).length;

  return (
    <Page>
      <PageHeader
        title="Pipelines"
        subtitle="Transform datasets into reviewed, published outputs you can query and rebuild."
        actions={
          role !== "viewer" && (
            <ButtonLink variant="primary" icon={Plus} to={paths.pipelineNew()}>
              New pipeline
            </ButtonLink>
          )
        }
      />
      {loading ? (
        <Skeleton height={120} />
      ) : empty ? (
        <EmptyState
          icon={Workflow}
          title="No pipelines yet"
          text="Build a visual transform graph or write SQL from your datasets. Ontology setup and Analyst can also publish pipelines."
          action={
            role !== "viewer" && (
              <ButtonLink variant="primary" icon={Plus} to={paths.pipelineNew()}>
                New pipeline
              </ButtonLink>
            )
          }
        />
      ) : (
        <>
          <div className="pp-search">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search pipelines"
              label="Search pipelines"
            />
          </div>
          {!items.length ? (
            <EmptyState
              size="sm"
              title="No matches"
              text="Try a different search."
            />
          ) : (
            <ul className="pp-list">
              {items.map((p) => (
                <li key={p.id}>
                  <Link to={paths.pipeline(p.id)}>
                    <Workflow size={18} aria-hidden />
                    <strong>{p.name}</strong>
                    <small>
                      {[
                        p.description,
                        p.data.inputs?.length
                          ? `${p.data.inputs.length} input${p.data.inputs.length === 1 ? "" : "s"}`
                          : null,
                        relative(p.updatedAt),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    <ChevronRight
                      className="pp-chevron"
                      size={16}
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
}
