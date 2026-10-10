// Every in-app URL is built through `paths`. Each area owns its helpers in
// areas/<area>/paths.ts; this file only merges them and keeps the core ones.
import { dataPaths } from "./areas/data/paths";
import { ontologyPaths } from "./areas/ontology/paths";
import { analystPaths } from "./areas/analyst/paths";
import { pipelinePaths } from "./areas/pipelines/paths";
import { workspacePaths } from "./areas/workspace/paths";

export const paths = {
  home: () => "/",
  onboarding: () => "/onboarding",
  login: () => "/login",
  register: () => "/register",
  invite: (token?: string) =>
    "/invite" + (token ? "?token=" + encodeURIComponent(token) : ""),
  ...dataPaths,
  ...ontologyPaths,
  ...analystPaths,
  ...pipelinePaths,
  ...workspacePaths,
};
