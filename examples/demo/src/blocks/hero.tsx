import { defineBlock, asset, blocks, select, text, textarea } from "folio/core";

export const hero = defineBlock({
  name: "hero",
  label: "Hero",
  summary: "heading",
  // What the block is for, for the editor's picker and an agent's get_schema alike
  // (`docs/specs/content-model/authoring-guidance.md` decision 5).
  help: "The first thing on a landing page: one promise, one image, at most two actions.",
  fields: {
    eyebrow: text({
      label: "Eyebrow",
      placeholder: "Small label above the heading",
      translatable: true,
    }),
    heading: text({
      label: "Heading",
      required: true,
      translatable: true,
      // Advisory: counted in the inspector and reported by check_document, never refused.
      length: { max: 60 },
      guidance: {
        tone: "Second person, present tense. Lead with what the reader gets.",
        examples: ["Find your next safari", "Plan a week on the coast"],
      },
    }),
    body: textarea({ label: "Body", rows: 3, translatable: true }),
    // Under a gradient and carrying no information, so it wants no alt text.
    image: asset({ label: "Background image", accept: "image/*", decorative: true }),
    align: select({
      label: "Alignment",
      options: [
        { label: "Left", value: "left" },
        { label: "Centre", value: "center" },
      ],
    }),
    actions: blocks({ label: "Actions", allow: ["button"], max: 2 }),
  },
  // A background image is decorative, so it goes through CSS and the focal point
  // becomes `background-position` rather than `object-position`.
  render: ({ eyebrow, heading, body, image, align, actions }) => (
    <section
      className={`hero hero--${align}`}
      style={
        image
          ? {
              backgroundImage: `linear-gradient(rgba(12,14,20,.55),rgba(12,14,20,.75)), url(${image.srcFor({ width: 1800, fit: "cover", format: "webp" })})`,
              backgroundPosition: image.objectPosition,
            }
          : undefined
      }
      data-has-image={image ? "true" : "false"}
    >
      <div className="hero__inner">
        {eyebrow ? <p className="hero__eyebrow">{eyebrow}</p> : null}
        <h1 className="hero__heading">{heading || "Untitled"}</h1>
        {body ? <p className="hero__body">{body}</p> : null}
        <div className="hero__actions">{actions}</div>
      </div>
    </section>
  ),
});
