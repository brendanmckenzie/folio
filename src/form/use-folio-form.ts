/**
 * `useFolioForm`: the headless hook (`../../docs/specs/content-model/form-steps.md`,
 * decisions 5 to 13 and 16).
 *
 * Inputs are **uncontrolled** (decision 6): the hook reads the DOM form through a
 * `FormData` and the same `answersFrom` the server runs, so what it holds is what a
 * native POST would send. Until mount it renders exactly what a server render does
 * (`formLayout(form)`, no answers, every step visible, no `noValidate`); after mount
 * it switches to the evaluated layout (decision 7). Every engine call sits inside one
 * `try`, and a throw degrades the form to the server render and a native POST
 * (decision 13) rather than unmounting the host's root.
 *
 * The state is a small store (`live`) mirrored into React state, because an event
 * handler must read the state its predecessor just wrote, not the one the last render
 * closed over: Enter, blur and input can arrive in one batch.
 */
import {
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Json } from "../core/doc";
import type { AnswerRefusal, SubmissionCheck } from "../core/form-answers";
import { prefillAnswers } from "../core/form-logic";
import { readSubmitStatus, SUBMIT_STATUSES, statusLocation } from "../core/form-status";
import type { SubmitStatus } from "../core/form-status";
import { formLayout } from "../core/forms";
import type {
  FormFieldOption,
  FormLayoutView,
  LayoutStep,
  ResolvedForm,
  ResolvedFormField,
} from "../core/forms";
import {
  checkDom,
  controlId,
  controlPropsOf,
  type DomCheck,
  enterAction,
  errorId,
  fieldMessage,
  firstControlId,
  groupPropsOf,
  type HookMessages,
  initialStep,
  labelId,
  navigation,
  neighbour,
  type Problem,
  problemsOf,
  sanitiseId,
  type StatusView,
  type StepNav,
  statusView,
  transportBody,
} from "./model";

export interface FolioFormOptions {
  /** The page's query string, from the host's router. Drives status and prefill. */
  search?: string | URLSearchParams;
  /** The host's own prefill map (`prefillAnswers`' `values`). */
  values?: Record<string, unknown>;
  messages?: HookMessages;
  /** `'fetch'` (default) posts the form itself and keeps every answer on a refusal;
   *  `'native'` validates on the client and lets the browser post. */
  transport?: "fetch" | "native";
  /** Prefix for every id the hook mints. Default `folio-<form.name>-<useId()>`, with
   *  `useId`'s output reduced to `[A-Za-z0-9_-]`. */
  idPrefix?: string;
  onSubmitted?(result: {
    ok: true;
    id: string;
    actions?: Record<string, Record<string, string | number>>;
  }): void;
}

type ElementRef = (el: HTMLElement | null) => void;

export interface FolioForm {
  mounted: boolean;
  degraded: boolean;
  /** `mounted && !degraded` and the form has steps. */
  stepped: boolean;
  layout: FormLayoutView;
  answers: Record<string, Json>;
  status: StatusView | null;
  problems: readonly Problem[];
  pending: boolean;
  /** Increments each time a request is sent: a host keys its captcha widget on it. */
  attempt: number;
  steps: readonly StepNav[];
  current: string | null;
  isFirst: boolean;
  isLast: boolean;
  next(): boolean;
  back(): void;
  goTo(step: string): boolean;
  focus(name: string): void;

  formProps(): {
    ref: RefObject<HTMLFormElement | null>;
    method: "post";
    action: string;
    encType: ResolvedForm["enctype"];
    noValidate?: true;
    onSubmit(event: FormEvent<HTMLFormElement>): void;
    onInput(event: FormEvent<HTMLFormElement>): void;
    onChange(event: FormEvent<HTMLFormElement>): void;
    onBlur(event: FocusEvent<HTMLFormElement>): void;
    onKeyDown(event: KeyboardEvent<HTMLFormElement>): void;
  };
  honeypotProps(): {
    type: "text";
    name: string;
    tabIndex: -1;
    autoComplete: "off";
    "aria-hidden": true;
  };
  /** `form.hidden` (`_folio_page`, `_folio_locale`), for the host to emit verbatim. */
  hidden: readonly { name: string; value: string }[];
  stepProps(step: LayoutStep): {
    ref: ElementRef;
    hidden?: true;
    style?: { display: "none" };
    tabIndex: -1;
    role?: "group";
    "aria-labelledby"?: string;
    "data-folio-step"?: string;
    "data-folio-current"?: "";
  };
  stepLabelProps(step: LayoutStep): { id: string; tabIndex: -1; ref: ElementRef };
  labelProps(field: ResolvedFormField, option?: FormFieldOption): { htmlFor: string; id: string };
  /** `radio` and `checkboxes`: the container of the options, labelled by the legend. */
  groupProps(field: ResolvedFormField): ReturnType<typeof groupPropsOf>;
  controlProps(field: ResolvedFormField, option?: FormFieldOption): Record<string, unknown>;
  errorFor(name: string): { token: AnswerRefusal; message: string } | null;
  errorProps(field: ResolvedFormField): { id: string } | null;
  summaryProps(): {
    ref: ElementRef;
    tabIndex: -1;
    role: "alert";
    "aria-labelledby": string;
  };
  summaryTitleProps(): { id: string };
  problemLinkProps(problem: Problem): { href: string; onClick(event: MouseEvent): void };
  statusProps(): { ref: ElementRef; tabIndex: -1; role: "status" | "alert" };
  nextProps(): { type: "button"; onClick(): void; disabled?: true };
  backProps(): { type: "button"; onClick(): void; hidden?: true };
  submitProps(): { type: "submit"; disabled?: true; hidden?: true; "aria-busy"?: true };
}

/* ------------------------------------------------------------------- state --- */

interface Core {
  mounted: boolean;
  degraded: boolean;
  /** The DOM form's answers at the last read; `null` until mount. */
  answers: Record<string, Json> | null;
  check: SubmissionCheck | null;
  /** The live client errors (file approximations in, unavailable lists out). */
  errors: Record<string, AnswerRefusal>;
  /** The step the visitor chose. The one shown is always `evaluate`'s, which clamps it. */
  current: string | null;
  /** The refusals the summary lists: the round trip's, a fetch `422`'s, or a failed check. */
  refusals: Record<string, AnswerRefusal>;
  /** Questions that lost focus while refused. */
  touched: ReadonlySet<string>;
  outcome: StatusView | null;
  pending: boolean;
  attempt: number;
}

type Focus =
  | { kind: "summary" }
  | { kind: "status" }
  | { kind: "step"; name: string }
  | { kind: "control"; name: string };

const NO_ERRORS: Record<string, AnswerRefusal> = {};

const emptyLayout = (): FormLayoutView => ({
  sections: [{ section: null, rows: [] }],
  steps: [{ step: null, sections: [{ section: null, rows: [] }] }],
  inputs: [],
});

interface View {
  layout: FormLayoutView;
  current: string | null;
  error: unknown;
}

/** Decision 7: the evaluated layout once mounted, the server render's before, and the
 *  current step clamped to one the layout still renders after every recompute. */
function evaluate(
  form: ResolvedForm,
  answers: Record<string, Json> | null,
  stored: string | null,
  active: boolean,
  pull?: readonly string[],
): View {
  try {
    if (!active || answers === null)
      return { layout: formLayout(form), current: null, error: null };
    const layout = formLayout(form, answers);
    const current = initialStep(layout, {
      order: (form.steps ?? []).map((s) => s.name),
      current: stored,
      pull,
    });
    return { layout, current, error: null };
  } catch (error) {
    let layout: FormLayoutView;
    try {
      layout = formLayout(form);
    } catch {
      layout = emptyLayout();
    }
    return { layout, current: null, error };
  }
}

const isRefusal = (v: unknown): v is AnswerRefusal =>
  v === "required" || v === "invalid" || v === "too_long" || v === "out_of_range";

function refusalsFrom(raw: unknown, known: ReadonlySet<string>): Record<string, AnswerRefusal> {
  const out: Record<string, AnswerRefusal> = {};
  if (raw && typeof raw === "object") {
    for (const [name, token] of Object.entries(raw)) {
      if (known.has(name)) out[name] = isRefusal(token) ? token : "invalid";
    }
  }
  return out;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* -------------------------------------------------------------------- hook --- */

export function useFolioForm(form: ResolvedForm, options: FolioFormOptions = {}): FolioForm {
  const { messages, transport = "fetch", values } = options;
  const searchKey =
    options.search === undefined
      ? ""
      : typeof options.search === "string"
        ? options.search
        : options.search.toString();
  const reactId = useId();
  const prefix = options.idPrefix ?? `folio-${sanitiseId(form.name)}-${sanitiseId(reactId)}`;

  const trip = useMemo(() => readSubmitStatus(form, searchKey), [form, searchKey]);
  const tripRefusals = useMemo(() => {
    const out: Record<string, AnswerRefusal> = {};
    if (trip?.kind === "invalid") for (const name of trip.invalid) out[name] = "invalid";
    return out;
  }, [trip]);

  const initial = (): Core => ({
    mounted: false,
    degraded: false,
    answers: null,
    check: null,
    errors: NO_ERRORS,
    current: null,
    refusals: tripRefusals,
    touched: new Set(),
    outcome: null,
    pending: false,
    attempt: 0,
  });
  const [core, setCore] = useState<Core>(initial);
  const live = useRef<Core>(core);
  const latest = useRef({ form, messages, transport, options, prefix });
  latest.current = { form, messages, transport, options, prefix };

  // A new query string is a new round trip: forget the old outcome and re-read it.
  const [seenKey, setSeenKey] = useState(searchKey);
  if (seenKey !== searchKey) {
    setSeenKey(searchKey);
    live.current = { ...live.current, refusals: tripRefusals, outcome: null };
    setCore(live.current);
  }

  const formEl = useRef<HTMLFormElement | null>(null);
  const summaryEl = useRef<HTMLElement | null>(null);
  const statusEl = useRef<HTMLElement | null>(null);
  const stepEls = useRef(new Map<string, HTMLElement>());
  const labelEls = useRef(new Map<string, HTMLElement>());
  const focusReq = useRef<Focus | null>(null);

  const commit = (patch: Partial<Core>) => {
    live.current = { ...live.current, ...patch };
    setCore(live.current);
  };

  const degrade = (err: unknown) => {
    if (live.current.degraded) return;
    console.error("folio/form: the form fell back to the server render", err);
    commit({ degraded: true, mounted: true });
  };

  const active = core.mounted && !core.degraded;

  const prefill = useMemo(() => {
    try {
      return { answers: prefillAnswers(form, { query: searchKey, values }), error: null };
    } catch (error) {
      return { answers: {} as Record<string, Json>, error };
    }
  }, [form, searchKey, values]);

  const view = useMemo(
    () => evaluate(form, core.answers, core.current, active),
    [form, core.answers, core.current, active],
  );

  // A throw while rendering (a descriptor the engine cannot read) degrades too.
  const renderError = view.error ?? prefill.error;
  useEffect(() => {
    if (renderError) degrade(renderError);
  });

  const hasSteps = (form.steps?.length ?? 0) > 0;
  const stepped = active && hasSteps;
  const answers = core.answers ?? prefill.answers;

  const nav = useMemo(
    () =>
      stepped
        ? navigation(form, view.layout, core.check?.state.steps ?? null, core.errors, view.current)
        : [],
    [stepped, form, view.layout, core.check, core.errors, view.current],
  );
  const isFirst = !stepped || neighbour(nav, view.current, -1) === null;
  const isLast = !stepped || neighbour(nav, view.current, 1) === null;

  /* --------------------------------------------------------------- reading --- */

  const read = (): { dom: DomCheck; data: FormData } | null => {
    const el = formEl.current;
    if (!el) return null;
    const data = new FormData(el);
    return { dom: checkDom(latest.current.form, data), data };
  };

  const same = (dom: DomCheck) =>
    sameJson(dom.answers, live.current.answers) && sameJson(dom.errors, live.current.errors);

  /** Absorb a fresh read: the answers, the check, and the current step re-clamped. */
  const absorb = (dom: DomCheck, patch: Partial<Core> = {}, pull?: readonly string[]) => {
    const next = { ...live.current, ...patch };
    const ev = evaluate(latest.current.form, dom.answers, next.current, true, pull);
    if (ev.error) throw ev.error;
    commit({
      ...patch,
      answers: dom.answers,
      check: dom.check,
      errors: dom.errors,
      current: ev.current,
    });
    return ev;
  };

  const view$ = () => {
    const c = live.current;
    const ev = evaluate(latest.current.form, c.answers, c.current, true);
    if (ev.error) throw ev.error;
    return ev;
  };

  const navNow = (ev: View) =>
    navigation(
      latest.current.form,
      ev.layout,
      live.current.check?.state.steps ?? null,
      live.current.errors,
      ev.current,
    );

  const on = (name: string) =>
    latest.current.form.fields.filter((f) => f.step === name).map((f) => f.name);

  /* -------------------------------------------------------------- showing --- */

  const showRefusals = (
    dom: DomCheck,
    refusals: Record<string, AnswerRefusal>,
    pull?: readonly string[],
    extra: Partial<Core> = {},
  ) => {
    absorb(dom, { refusals, outcome: null, ...extra }, pull);
    focusReq.current = { kind: "summary" };
  };

  /* ------------------------------------------------------------ navigation --- */

  const next = (): boolean => {
    const c = live.current;
    if (!c.mounted || c.degraded) return false;
    try {
      const fresh = read();
      if (!fresh) return false;
      const { dom } = fresh;
      const ev = absorb(dom);
      const target = neighbour(navNow(ev), ev.current, 1);
      if (!target || ev.current === null) return false;
      const here = new Set(on(ev.current));
      const refused = Object.fromEntries(Object.entries(dom.errors).filter(([n]) => here.has(n)));
      if (Object.keys(refused).length > 0) {
        commit({ refusals: refused, outcome: null });
        focusReq.current = { kind: "summary" };
        return false;
      }
      commit({ current: target, refusals: {}, outcome: null });
      focusReq.current = { kind: "step", name: target };
      return true;
    } catch (err) {
      degrade(err);
      return false;
    }
  };

  const back = () => {
    const c = live.current;
    if (!c.mounted || c.degraded) return;
    try {
      const fresh = read();
      const ev = fresh ? absorb(fresh.dom) : view$();
      const target = neighbour(navNow(ev), ev.current, -1);
      if (!target) return;
      commit({ current: target, refusals: {}, outcome: null });
      focusReq.current = { kind: "step", name: target };
    } catch (err) {
      degrade(err);
    }
  };

  const goTo = (step: string): boolean => {
    const c = live.current;
    if (!c.mounted || c.degraded) return false;
    try {
      const fresh = read();
      const ev = fresh ? absorb(fresh.dom) : view$();
      const all = navNow(ev);
      const target = all.find((s) => s.name === step);
      if (!target?.available) return false;
      if (step === ev.current) return true;
      const here = all.find((s) => s.name === ev.current);
      if (here && target.index > here.index) {
        const blocking = all.filter((s) => s.available && s.index < target.index && !s.complete);
        if (blocking.length > 0) {
          const names = new Set(blocking.flatMap((s) => on(s.name)));
          const refused = Object.fromEntries(
            Object.entries(live.current.errors).filter(([n]) => names.has(n)),
          );
          commit({ refusals: refused, outcome: null });
          focusReq.current = { kind: "summary" };
          return false;
        }
      }
      commit({ current: step, refusals: {}, outcome: null });
      focusReq.current = { kind: "step", name: step };
      return true;
    } catch (err) {
      degrade(err);
      return false;
    }
  };

  const focusControl = (name: string) => {
    const c = live.current;
    const field = latest.current.form.fields.find((f) => f.name === name);
    if (!field) return;
    if (c.mounted && !c.degraded && field.step && field.step !== view$().current) {
      const target = navNow(view$()).find((s) => s.name === field.step);
      if (target?.available) commit({ current: field.step });
    }
    focusReq.current = { kind: "control", name };
    commit({});
  };

  /* ---------------------------------------------------------------- submit --- */

  const finish = (outcome: StatusView) => {
    commit({ outcome, pending: false });
    focusReq.current = { kind: "status" };
  };

  const sendFetch = async (data: FormData) => {
    const f = latest.current.form;
    commit({ pending: true, attempt: live.current.attempt + 1, refusals: {}, outcome: null });
    let res: Response;
    try {
      res = await fetch(f.action, {
        method: "POST",
        headers: { accept: "application/json" },
        body: transportBody(f.enctype, data),
      });
    } catch {
      // The request may have arrived: no native resubmission (decision 8).
      finish(statusView(f, { kind: "error" }, latest.current.messages));
      return;
    }
    let reply: Record<string, unknown> | null = null;
    try {
      const body: unknown = await res.json();
      reply = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    } catch {
      reply = null;
    }

    if (res.ok && reply?.ok === true) {
      const out = statusView(f, { kind: "ok" }, latest.current.messages);
      finish(out);
      latest.current.options.onSubmitted?.({
        ok: true,
        id: typeof reply.id === "string" ? reply.id : "",
        ...(reply.actions && typeof reply.actions === "object"
          ? { actions: reply.actions as Record<string, Record<string, string | number>> }
          : {}),
      });
      if (f.redirectTo) {
        window.location.assign(
          statusLocation(f.redirectTo, window.location.href, { kind: "ok", form: f.name }),
        );
      }
      return;
    }

    const status = reply?.status;
    const kind: SubmitStatus =
      typeof status === "string" && (SUBMIT_STATUSES as readonly string[]).includes(status)
        ? (status as SubmitStatus)
        : "error";
    const error = (reply?.error ?? {}) as { code?: unknown; message?: unknown };
    const known = new Set(f.fields.map((x) => x.name));
    const fields = reply?.fields ? refusalsFrom(reply.fields, known) : null;
    const out = statusView(
      f,
      {
        kind,
        invalid: fields ? Object.keys(fields) : [],
        reason: typeof reply?.reason === "string" ? reply.reason : null,
        code: typeof error.code === "string" ? error.code : null,
        fields,
        reply: typeof error.message === "string" ? error.message : null,
      },
      latest.current.messages,
    );

    if (kind === "invalid" && fields && Object.keys(fields).length > 0) {
      // Answers stay exactly where they are; the visitor goes to the earliest refused step.
      try {
        const fresh = read();
        if (fresh) {
          absorb(
            fresh.dom,
            { refusals: fields, outcome: out, pending: false },
            Object.keys(fields),
          );
          focusReq.current = { kind: "summary" };
          return;
        }
      } catch (err) {
        degrade(err);
      }
      commit({ refusals: fields, outcome: out, pending: false });
      focusReq.current = { kind: "summary" };
      return;
    }
    finish(out);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const c = live.current;
    if (!c.mounted || c.degraded) return; // the browser posts
    const el = event.currentTarget;
    try {
      if (c.pending) {
        event.preventDefault();
        return;
      }
      const fresh = read();
      if (!fresh) return;
      const ev = absorb(fresh.dom);
      // Backstop for Enter and an implicit submit before the last step (decision 16).
      if (ev.current !== null && neighbour(navNow(ev), ev.current, 1) !== null) {
        event.preventDefault();
        next();
        return;
      }
      if (Object.keys(fresh.dom.errors).length > 0) {
        event.preventDefault();
        showRefusals(fresh.dom, { ...fresh.dom.errors }, Object.keys(fresh.dom.errors));
        return;
      }
      commit({ refusals: {}, outcome: null });
      if (latest.current.transport === "native") return;
      event.preventDefault();
      void sendFetch(fresh.data);
    } catch (err) {
      // After `preventDefault` a throw would swallow the submission: degrade, then let
      // the now-inert handler pass a native POST through.
      event.preventDefault();
      degrade(err);
      if (typeof el.requestSubmit === "function") el.requestSubmit();
      else el.submit();
    }
  };

  const refreshFromEvent = (touch?: string) => {
    const c = live.current;
    if (!c.mounted || c.degraded) return;
    try {
      const fresh = read();
      if (!fresh) return;
      const touched =
        touch !== undefined && fresh.dom.errors[touch] && !c.touched.has(touch)
          ? new Set([...c.touched, touch])
          : undefined;
      if (!touched && same(fresh.dom)) return;
      absorb(fresh.dom, touched ? { touched } : {});
    } catch (err) {
      degrade(err);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const c = live.current;
    if (!c.mounted || c.degraded) return;
    try {
      const target = event.target as unknown as HTMLInputElement;
      const ev = view$();
      const action = enterAction(
        {
          key: event.key,
          tag: target.tagName ?? "",
          type: target.type,
          isComposing: event.nativeEvent?.isComposing,
        },
        {
          stepped: (latest.current.form.steps?.length ?? 0) > 0,
          isLast: neighbour(navNow(ev), ev.current, 1) === null,
        },
      );
      if (action === "next") {
        event.preventDefault();
        next();
      }
    } catch (err) {
      degrade(err);
    }
  };

  /* ---------------------------------------------------------------- effects --- */

  // Focus is moved after the render that applies it: a step becomes visible, a summary
  // mounts. Declared before the mount effect so its first run has nothing to do.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the state commit
  useEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    focusReq.current = null;
    const el = formEl.current;
    const focusField = (name: string) => {
      const control = el?.querySelector<HTMLElement>(`[name="${name}"]`);
      if (!control) return;
      const lbl = control.id
        ? document.querySelector<HTMLElement>(`label[for="${control.id}"]`)
        : null;
      (lbl ?? control).scrollIntoView?.();
      control.focus({ preventScroll: true });
    };
    if (req.kind === "summary") {
      if (summaryEl.current) summaryEl.current.focus();
      else {
        const first = problemsOf(
          latest.current.form,
          view.layout,
          live.current.refusals,
          latest.current.messages,
        )[0];
        if (first) focusField(first.name);
      }
    } else if (req.kind === "status") statusEl.current?.focus();
    else if (req.kind === "step")
      (labelEls.current.get(req.name) ?? stepEls.current.get(req.name))?.focus();
    else focusField(req.name);
  }, [core]);

  // Mount only: later recomputes never pull the visitor back (decision 7).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only
  useEffect(() => {
    try {
      const el = formEl.current;
      const dom = el ? checkDom(form, new FormData(el)) : null;
      const answers0 = dom?.answers ?? prefill.answers;
      const pull = trip?.kind === "invalid" ? trip.invalid : undefined;
      const ev = evaluate(form, answers0, null, true, pull);
      if (ev.error) throw ev.error;
      commit({
        mounted: true,
        answers: answers0,
        check: dom?.check ?? null,
        errors: dom?.errors ?? NO_ERRORS,
        current: ev.current,
      });
      // As GOV.UK focuses the summary on page load; other statuses were announced by the load.
      if (trip?.kind === "invalid" && trip.invalid.length > 0)
        focusReq.current = { kind: "summary" };
    } catch (err) {
      degrade(err);
    }
  }, []);

  // A replaced descriptor (the admin preview) re-clamps the current step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a new descriptor only
  useEffect(() => {
    const c = live.current;
    if (!c.mounted || c.degraded) return;
    try {
      const fresh = read();
      if (!fresh) return;
      // Settle: a host that passes a new descriptor object every render must not
      // re-render itself forever, so commit only when the read or the clamp moved.
      const ev = evaluate(latest.current.form, fresh.dom.answers, c.current, true);
      if (ev.error) throw ev.error;
      if (same(fresh.dom) && ev.current === c.current) return;
      absorb(fresh.dom);
    } catch (err) {
      degrade(err);
    }
  }, [form]);

  /* ------------------------------------------------------------ prop getters --- */

  const problems = problemsOf(form, view.layout, core.refusals, messages);
  const status: StatusView | null =
    core.outcome ?? (trip ? statusView(form, trip, messages) : null);

  const refusalFor = (name: string): AnswerRefusal | undefined =>
    (Object.hasOwn(core.refusals, name) ? core.refusals[name] : undefined) ??
    (core.touched.has(name) && Object.hasOwn(core.errors, name) ? core.errors[name] : undefined);

  const errorFor = (name: string) => {
    const token = refusalFor(name);
    return token ? { token, message: fieldMessage(token, messages) } : null;
  };

  const requiredNow = (field: ResolvedFormField): boolean => {
    if (!active || !core.check) return field.required;
    return core.check.state.required.has(field.name);
  };

  const stepLabelId = (step: LayoutStep) =>
    step.step ? `${prefix}-step-${step.step.name}-label` : `${prefix}-step`;

  return {
    mounted: core.mounted,
    degraded: core.degraded,
    stepped,
    layout: view.layout,
    answers,
    status,
    problems,
    pending: core.pending,
    attempt: core.attempt,
    steps: nav,
    current: view.current,
    isFirst,
    isLast,
    next,
    back,
    goTo,
    focus: focusControl,

    formProps: () => ({
      ref: formEl,
      method: "post",
      action: form.action,
      encType: form.enctype,
      ...(stepped ? { noValidate: true as const } : {}),
      onSubmit,
      onInput: () => refreshFromEvent(),
      onChange: () => refreshFromEvent(),
      onBlur: (event) => {
        const name = (event.target as unknown as HTMLInputElement).name;
        if (name) refreshFromEvent(name);
      },
      onKeyDown,
    }),
    honeypotProps: () => ({
      type: "text",
      name: form.honeypot,
      tabIndex: -1,
      autoComplete: "off",
      "aria-hidden": true,
    }),
    hidden: form.hidden,
    stepProps: (step) => {
      const name = step.step?.name;
      if (name === undefined) return { ref: () => {}, tabIndex: -1 };
      const current = stepped && view.current === name;
      const hide = stepped && view.current !== null && !current;
      return {
        ref: (el) => {
          if (el) stepEls.current.set(name, el);
          else stepEls.current.delete(name);
        },
        ...(hide ? { hidden: true as const, style: { display: "none" as const } } : {}),
        tabIndex: -1,
        role: "group",
        "aria-labelledby": stepLabelId(step),
        "data-folio-step": name,
        ...(current ? { "data-folio-current": "" as const } : {}),
      };
    },
    stepLabelProps: (step) => ({
      id: stepLabelId(step),
      tabIndex: -1,
      ref: (el) => {
        const name = step.step?.name;
        if (name === undefined) return;
        if (el) labelEls.current.set(name, el);
        else labelEls.current.delete(name);
      },
    }),
    labelProps: (field, option) => ({
      htmlFor: option ? controlId(prefix, field.name, option) : firstControlId(prefix, field),
      id: labelId(prefix, field.name, option),
    }),
    groupProps: (field) =>
      groupPropsOf(field, {
        prefix,
        required: requiredNow(field),
        invalid: refusalFor(field.name) !== undefined,
      }),
    controlProps: (field, option) =>
      controlPropsOf(field, option, {
        prefix,
        required: requiredNow(field),
        answer: answers[field.name] ?? prefill.answers[field.name],
        invalid: refusalFor(field.name) !== undefined,
      }),
    errorFor,
    errorProps: (field) => (refusalFor(field.name) ? { id: errorId(prefix, field.name) } : null),
    summaryProps: () => ({
      ref: (el) => {
        summaryEl.current = el;
      },
      tabIndex: -1,
      role: "alert",
      "aria-labelledby": `${prefix}-summary-title`,
    }),
    summaryTitleProps: () => ({ id: `${prefix}-summary-title` }),
    problemLinkProps: (problem) => {
      const field = form.fields.find((f) => f.name === problem.name);
      return {
        href: `#${field ? firstControlId(prefix, field) : controlId(prefix, problem.name)}`,
        onClick: (event) => {
          event.preventDefault();
          focusControl(problem.name);
        },
      };
    },
    statusProps: () => ({
      ref: (el) => {
        statusEl.current = el;
      },
      tabIndex: -1,
      role: status?.kind === "ok" ? "status" : "alert",
    }),
    nextProps: () => ({
      type: "button",
      onClick: () => {
        next();
      },
      ...(isLast ? { disabled: true as const } : {}),
    }),
    backProps: () => ({
      type: "button",
      onClick: back,
      ...(isFirst ? { hidden: true as const } : {}),
    }),
    submitProps: () => ({
      type: "submit",
      ...(core.pending ? { disabled: true as const, "aria-busy": true as const } : {}),
      ...(stepped && !isLast ? { hidden: true as const } : {}),
    }),
  };
}
