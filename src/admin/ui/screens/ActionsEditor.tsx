import type { Json } from "../../../core/doc";
import { matches } from "../../../core/conditions";
import type { FormActionAttachment, FormActionInfo } from "../../../core/form-actions";
import type { FormField, FormLayout } from "../../../core/forms";
import { Badge } from "../Badge";
import { Button } from "../Button";
import { Field, Select, Textarea } from "../Field";
import { Menu, type MenuItem } from "../Menu";
import css from "./ActionsEditor.module.css";
import {
  attachAction,
  compatibleQuestions,
  detachAction,
  messageText,
  moveAction,
  offerableActions,
  problemsOf,
  withActionSetting,
  withMapping,
  withMessage,
} from "./form-model";
import { SettingControl } from "./OptionSourceEditor";

interface Props {
  attachments: readonly FormActionAttachment[];
  /** The brand's registered actions. */
  actions: readonly FormActionInfo[];
  /** Why the registry could not be read, when it could not. */
  registryError?: string | undefined;
  fields: readonly FormField[];
  layout: FormLayout;
  /** `canReadResponses(me)` and the builder's own `canEdit`: only a publisher decides
   *  where responses go (decision 8), so below it the section reads and never writes. */
  mayConfigure: boolean;
  /** The builder's active locale, and the source locale. */
  locale: string;
  source: string;
  onChange: (next: FormActionAttachment[]) => void;
}

/**
 * Which actions a form runs, in run order, and for each: which question feeds each
 * input, the settings, and what a visitor is told for each refusal code
 * (`form-actions.md` decisions 3 to 7). Everything decidable is in `form-model.ts`
 * (`attachAction`, `withMapping`, `problemsOf`, ...); this draws it.
 *
 * **Drift is shown, not hidden** (decision 13): an attachment whose action the code no
 * longer registers is listed with Remove, and an attachment that no longer satisfies
 * its action lists each problem in place.
 */
export function ActionsEditor({
  attachments,
  actions,
  registryError,
  fields,
  layout,
  mayConfigure,
  locale,
  source,
  onChange,
}: Props) {
  const infos = new Map(actions.map((info) => [info.id, info]));
  const translating = locale !== "" && locale !== source;
  const offered = offerableActions(actions, attachments);
  const items: MenuItem[] = offered.map((info) => ({
    id: info.id,
    label: info.label,
    run: () => onChange(attachAction(attachments, info)),
  }));

  return (
    <section className={css.section} aria-label="Where responses go">
      <h3 className={css.heading}>Where responses go</h3>
      {!mayConfigure ? (
        <p className={css.note}>Only a publisher can change where responses go.</p>
      ) : null}
      {registryError ? (
        <p className={css.note} role="status">
          {`The actions this site offers could not be listed: ${registryError}`}
        </p>
      ) : null}
      {attachments.length === 0 && !registryError ? (
        <p className={css.note}>
          {actions.length === 0
            ? "This site has no form actions. A developer registers them in the host's forms config."
            : "No actions yet. Responses are stored and nothing else happens."}
        </p>
      ) : null}

      {attachments.map((attachment, index) => {
        const info = infos.get(attachment.action);
        return (
          <div className={css.attachment} key={attachment.action}>
            <div className={css.attachmentHead}>
              <span className={css.attachmentName}>{info?.label ?? attachment.action}</span>
              {info?.check ? (
                <Badge title="Runs before the response is stored">Checks</Badge>
              ) : null}
              {info?.deliver ? (
                <Badge title="Runs after the response is stored">Delivers</Badge>
              ) : null}
              <Button
                size="sm"
                variant="subtle"
                disabled={!mayConfigure || index === 0}
                reason={!mayConfigure ? "Only a publisher can change this" : "Already first"}
                aria-label={`Run ${info?.label ?? attachment.action} earlier`}
                onClick={() => onChange(moveAction(attachments, attachment.action, -1))}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="subtle"
                disabled={!mayConfigure || index === attachments.length - 1}
                reason={!mayConfigure ? "Only a publisher can change this" : "Already last"}
                aria-label={`Run ${info?.label ?? attachment.action} later`}
                onClick={() => onChange(moveAction(attachments, attachment.action, 1))}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!mayConfigure}
                reason="Only a publisher can change this"
                aria-label={`Remove ${info?.label ?? attachment.action}`}
                onClick={() => onChange(detachAction(attachments, attachment.action))}
              >
                ×
              </Button>
            </div>

            {info === undefined ? (
              <p className={css.gone}>
                No longer provided by this site's code. Submissions are stored; a check is not run,
                and a delivery is recorded as failed until the action is restored or removed here.
              </p>
            ) : (
              <AttachmentBody
                attachment={attachment}
                info={info}
                fields={fields}
                layout={layout}
                mayConfigure={mayConfigure}
                locale={locale}
                source={source}
                translating={translating}
                onChange={onChange}
                attachments={attachments}
              />
            )}
          </div>
        );
      })}

      {mayConfigure && !translating ? (
        <Menu
          trigger="Add an action…"
          items={
            items.length > 0
              ? items
              : [
                  {
                    id: "none",
                    label: "Nothing left to add",
                    disabled: true,
                    reason:
                      actions.length === 0
                        ? "This site registers no form actions"
                        : "Every action is already attached",
                    run: () => undefined,
                  },
                ]
          }
        />
      ) : null}
    </section>
  );
}

function AttachmentBody({
  attachment,
  attachments,
  info,
  fields,
  layout,
  mayConfigure,
  locale,
  source,
  translating,
  onChange,
}: {
  attachment: FormActionAttachment;
  attachments: readonly FormActionAttachment[];
  info: FormActionInfo;
  fields: readonly FormField[];
  layout: FormLayout;
  mayConfigure: boolean;
  locale: string;
  source: string;
  translating: boolean;
  onChange: (next: FormActionAttachment[]) => void;
}) {
  const problems = problemsOf(attachment, info, fields, layout);
  const settings = Object.entries(info.settings);
  const values = (attachment.settings ?? {}) as Record<string, Json>;
  const edit = mayConfigure && !translating;
  return (
    <>
      {info.description ? <p className={css.description}>{info.description}</p> : null}
      {problems.length > 0 ? (
        <ul className={css.problems} role="alert" aria-label={`Problems with ${info.label}`}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      {!translating && info.inputs.length > 0 ? (
        <div className={css.group}>
          <p className={css.groupTitle}>Questions it reads</p>
          {info.inputs.map((input) => {
            const options = compatibleQuestions(input, fields);
            const mapped = attachment.map?.[input.name] ?? "";
            // A mapping to a question that is gone or no longer fits is kept visible
            // rather than blanked, so the editor sees what to change.
            const stale = mapped !== "" && !options.some((f) => f.name === mapped);
            return (
              <Field
                key={input.name}
                label={input.label}
                required={input.required}
                {...(input.help ? { help: input.help } : {})}
              >
                {(id) => (
                  <Select
                    id={id}
                    value={mapped}
                    disabled={!edit}
                    onChange={(e) =>
                      onChange(
                        withMapping(attachments, attachment.action, input.name, e.target.value),
                      )
                    }
                  >
                    <option value="">—</option>
                    {stale ? <option value={mapped}>{`${mapped} (does not fit)`}</option> : null}
                    {options.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.label || f.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            );
          })}
        </div>
      ) : null}

      {!translating && settings.length > 0 ? (
        <div className={css.group}>
          <p className={css.groupTitle}>Settings</p>
          {settings
            .filter(([, def]) => def.showIf === undefined || matches(def.showIf, values))
            .map(([name, def]) => (
              <SettingControl
                key={name}
                name={name}
                def={def}
                value={attachment.settings?.[name]}
                editable={edit}
                onChange={(value) =>
                  onChange(withActionSetting(attachments, attachment.action, name, value))
                }
                onCommit={() => undefined}
              />
            ))}
        </div>
      ) : null}

      {info.check && info.codes.length > 0 ? (
        <div className={css.group}>
          <p className={css.groupTitle}>
            {translating
              ? "What a visitor reads in this language"
              : "What a visitor reads when refused"}
          </p>
          {info.codes.map((code) => (
            <Field
              key={code.code}
              label={code.label}
              help={`Code: ${attachment.action}.${code.code}`}
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={messageText(attachment, code.code, locale, source)}
                  disabled={!mayConfigure}
                  placeholder={
                    translating
                      ? messageText(attachment, code.code, source, source) || code.message
                      : code.message
                  }
                  onChange={(e) =>
                    onChange(
                      withMessage(
                        attachments,
                        attachment.action,
                        code.code,
                        e.target.value,
                        locale,
                        source,
                      ),
                    )
                  }
                />
              )}
            </Field>
          ))}
        </div>
      ) : null}
    </>
  );
}
