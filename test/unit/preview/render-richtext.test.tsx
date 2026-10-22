import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { richtext } from "../../../src/core";
import { RenderRichtext } from "../../../src/preview/Render";

const doc = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Title" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
        { type: "text", text: " and " },
        { type: "text", text: "italic", marks: [{ type: "italic" }] },
        {
          type: "text",
          text: "bad",
          marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
        },
      ],
    },
  ],
};

describe("RenderRichtext", () => {
  it("drops marks and nodes the field does not permit, keeping the words", () => {
    const html = renderToStaticMarkup(
      <RenderRichtext value={doc} field={richtext({ marks: ["bold"], nodes: ["paragraph"] })} />,
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<h2>");
    expect(html).toContain("Title");
  });

  it("always strips an unsafe href, even with no field", () => {
    const html = renderToStaticMarkup(<RenderRichtext value={doc} />);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad");
  });

  it("renders an unresolvable internal link as a broken placeholder", () => {
    const value = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "gone",
              marks: [{ type: "link", attrs: { link: { kind: "story", id: "nope" } } }],
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(<RenderRichtext value={value} />);
    expect(html).toBe('<p><a href="#" data-broken="true">gone</a></p>');
  });

  it("accepts a legacy plain string", () => {
    expect(renderToStaticMarkup(<RenderRichtext value={"a\n\nb"} />)).toBe("<p>a</p><p>b</p>");
  });
});
