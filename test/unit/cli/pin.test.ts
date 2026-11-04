import { describe, expect, it } from "vitest";
import { lib } from "./load";

const { classifyPin } = await lib<{
  classifyPin: (spec: string) => { kind: string; ref: string | null; version?: string };
}>("pin");

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("classifyPin", () => {
  const table: [string, string, string | null][] = [
    ["github:brendanmckenzie/folio#v1.3.0", "tag", "v1.3.0"],
    [`github:brendanmckenzie/folio#${SHA}`, "sha", SHA],
    ["github:brendanmckenzie/folio#0123abc", "short-sha", "0123abc"],
    ["github:brendanmckenzie/folio#main", "branch", "main"],
    ["github:brendanmckenzie/folio#semver:^1.0.0", "semver-range", "semver:^1.0.0"],
    ["github:brendanmckenzie/folio", "default-branch", null],
    ["git+ssh://git@github.com/brendanmckenzie/folio.git#v1.3.0", "tag", "v1.3.0"],
    ["git+https://github.com/brendanmckenzie/folio.git#v1.2.4", "tag", "v1.2.4"],
    ["brendanmckenzie/folio#v1.3.1", "tag", "v1.3.1"],
    [`git+file:///x/folio#${SHA}`, "local-git", SHA],
    ["file:../folio", "path", "file:../folio"],
    ["link:../folio", "path", "link:../folio"],
    ["workspace:*", "workspace", "*"],
    ["^1.3.0", "registry", "^1.3.0"],
    ["1.3.0", "registry", "1.3.0"],
    ["latest", "registry", "latest"],
  ];
  for (const [spec, kind, ref] of table) {
    it(`${spec} is ${kind}`, () => {
      expect(classifyPin(spec)).toMatchObject({ kind, ref });
    });
  }

  it("carries the version of a tag", () => {
    expect(classifyPin("github:brendanmckenzie/folio#v1.3.0").version).toBe("1.3.0");
  });
});
