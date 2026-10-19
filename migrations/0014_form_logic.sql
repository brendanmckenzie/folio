-- Conditional questions, sections and prefill (docs/specs/content-model/form-logic.md).
--
-- Two additive columns. Both are read by this release, so the migration must be
-- applied BEFORE the Worker that reads them is deployed (0013's rule): a Worker
-- selecting forms.layout on a database without it fails every form read with
-- `no such column`.

-- JSON object { sections?: FormSection[] }. Validated by core/forms.ts
-- validateFormLayout on write, narrowed by readFormLayout on read. A layout
-- mistake drops layout; it can never empty a form's questions.
alter table forms add column layout text not null default '{}';

-- JSON array of field names this response was never asked (decision 9). '[]' for
-- every row written before this migration, which is honest: nothing could be
-- unasked before conditions existed.
alter table form_responses add column unasked text not null default '[]';
