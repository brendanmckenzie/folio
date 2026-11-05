import { Component, type ComponentProps, lazy, type ReactNode, Suspense, useMemo } from "react";
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
 * that is gone, or the network drops. An unhandled rejection unmounts the whole root,
 * so a boundary contains it to this field. **There is no in-place retry**: a module
 * whose dynamic `import()` failed is cached as failed in the browser's module map, so
 * a second `import()` of the same URL rejects without a request, and recreating the
 * `lazy` component cannot change that. A reload is the only recovery, and after a
 * deploy it is the right one anyway.
 */

type Props = ComponentProps<typeof RichTextField>;
type Loader = () => Promise<{ RichTextField: (props: Props) => ReactNode }>;

const loadEditor: Loader = () => import("./RichTextField");

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={css.rtPending} role="alert">
        <p className={css.note}>The editor could not be loaded. Reload the page to try again.</p>
        <Button size="sm" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      </div>
    );
  }
}

export function LazyRichText({ load = loadEditor, ...props }: Props & { load?: Loader }) {
  // Memoised: a `lazy` made per render is a new component type, which remounts.
  const Editor = useMemo(
    () => lazy(() => load().then((m) => ({ default: m.RichTextField }))),
    [load],
  );
  return (
    <Boundary>
      <Suspense fallback={<div className={css.rtPending} aria-busy="true" />}>
        <Editor {...props} />
      </Suspense>
    </Boundary>
  );
}
