import {
  Component,
  type ComponentProps,
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useMemo,
  useState,
} from "react";
import { Button } from "../../Button";
import css from "./fields.module.css";
import type { RichTextField } from "./RichTextField";

/**
 * The rich-text field as its own chunk: TipTap and ProseMirror are over half the
 * admin's JavaScript and most screens have no prose field. **Nothing else may import
 * `RichTextField` or `useRichtext` for a value** (a type import is erased), or the
 * split saves nothing. Its CSS module is `fields.module.css`, which the rest of the
 * fields share, so it stays in the entry's one stylesheet.
 *
 * A chunk can fail to load: a tab left open across a deploy asks for a hashed file
 * that is gone, or the network drops. `React.lazy` caches the rejection and an
 * unhandled one unmounts the whole root, so the failure is contained to this field
 * by a boundary, and Retry builds a **new** lazy component, because the old one would
 * answer the same rejection without asking again.
 */

type Props = ComponentProps<typeof RichTextField>;
type Loader = () => Promise<{ RichTextField: ComponentType<Props> }>;

const loadEditor: Loader = () => import("./RichTextField");

class Boundary extends Component<
  { onRetry: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={css.rtPending} role="alert">
        <p className={css.note}>
          The editor could not be loaded. Retry, or reload the page if this keeps happening (the
          admin may have been updated since this tab opened).
        </p>
        <Button
          size="sm"
          onClick={() => {
            this.props.onRetry();
            this.setState({ failed: false });
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
}

export function LazyRichText({ load = loadEditor, ...props }: Props & { load?: Loader }) {
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry token
  const Editor = useMemo(
    () => lazy(() => load().then((m) => ({ default: m.RichTextField }))),
    [load, attempt],
  );
  return (
    <Boundary onRetry={() => setAttempt((n) => n + 1)}>
      <Suspense fallback={<div className={css.rtPending} aria-busy="true" />}>
        <Editor {...props} />
      </Suspense>
    </Boundary>
  );
}
