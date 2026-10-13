export function handlerTemplate(opts: {
  name: string;
  description: string;
  price: string;
  tag: string;
}): string {
  return `import { configureDVM, z } from "@dvmkit/sdk";

const input = z.object({
  text: z.string().min(1),
});

export default configureDVM({
  name: ${JSON.stringify(opts.name)},
  description: ${JSON.stringify(opts.description)},
  capability: ${JSON.stringify(opts.tag)},
  tags: [${JSON.stringify(opts.tag)}],
  input,
  example: { text: "hello world" },
  price: ${JSON.stringify(opts.price)},

  async onJob(ctx) {
    ctx.text("Processing your request...");

    // Replace with your own logic
    ctx.artifact({
      data: JSON.stringify({ text: ctx.input.text }),
      mime_type: "application/json",
      name: "result.json",
    });
    ctx.complete(ctx.input.text);
  },
});
`;
}

export function testTemplate(opts: { name: string; tag: string }): string {
  return `import { describe, expect, it } from "vitest";
import { createTestContext } from "@dvmkit/sdk/testing";

import dvm from "./handler";

describe(${JSON.stringify(opts.name)}, () => {
  it("completes a job with typed input and an artifact", async () => {
    const ctx = createTestContext({ input: { text: "hello world" } });
    await dvm.capabilities[${JSON.stringify(opts.tag)}].onJob(ctx);

    expect(ctx.completed).toBe(true);
    expect(ctx.summary).toBe("hello world");
    expect(ctx.messages).toContainEqual(
      expect.objectContaining({
        type: "artifact",
        content: expect.objectContaining({ name: "result.json", mime_type: "application/json" }),
      })
    );
  });
});
`;
}
