/**
 * `folio/form`: the optional headless hook that binds a form descriptor to a host's
 * own inputs (`../../docs/specs/content-model/form-steps.md`, decision 5). React,
 * client-side. Nothing else is exported: the framework-free pieces it uses are in
 * `folio/core`.
 */
export { useFolioForm } from "./use-folio-form";
export type { FolioForm, FolioFormOptions } from "./use-folio-form";
