// Pipelines area: route components lazy-loaded by main.tsx.
import "./pipelines.css";
import { Route, Routes } from "react-router-dom";
import { NotFound } from "../../shell/ErrorBoundary";
import { PipelinesList } from "./list";
import { PipelineDetail } from "./detail";
import { PipelineEditor } from "./editor";

export function PipelinesHome() {
  return <PipelinesList />;
}
export function PipelinePage() {
  return <PipelineDetail />;
}
export function PipelineNewPage() {
  return <PipelineEditor mode="new" />;
}
export function PipelineEditPage() {
  return <PipelineEditor mode="edit" />;
}

// /pipelines/*: the Pipelines area's route table.
export function PipelinesRoutes() {
  return (
    <Routes>
      <Route index element={<PipelinesHome />} />
      <Route path="new" element={<PipelineNewPage />} />
      <Route path=":pipelineId/edit" element={<PipelineEditPage />} />
      <Route path=":pipelineId" element={<PipelinePage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
