import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError, API_PATHS, type CliTemplate, type DevConfig } from "./api.mjs";
import { CliError } from "./errors.mjs";
import { matchTemplate, parseProjectType, resolveNameAndDir, templateHint, templateLabel } from "./templates.mjs";
import { describeCreateError, describeWarning, devBlocker } from "../commands/create.mjs";
import { parseOpenTarget, urlForTarget } from "../commands/open.mjs";

const t = (id: string, name: string, over: Partial<CliTemplate> = {}): CliTemplate => ({
  id,
  name,
  type: "store",
  description: "",
  previewImage: null,
  previewUrl: null,
  starter: false,
  ...over,
});
const TEMPLATES = [t("ecommerce", "Modern Store", { starter: true }), t("store-beauty", "Beauty"), t("default", "Blank"), t("blank-website", "Blank", { type: "website" })];

describe("parseProjectType", () => {
  it("accepts store / website in any case, and nothing", () => {
    expect(parseProjectType(undefined)).toBeUndefined();
    expect(parseProjectType("Store")).toBe("store");
    expect(parseProjectType(" website ")).toBe("website");
  });
  it("names the valid values on anything else", () => {
    expect(() => parseProjectType("blog")).toThrow(/use store or website/);
  });
});

describe("matchTemplate", () => {
  it("matches an id, then a unique case-insensitive name", () => {
    expect(matchTemplate(TEMPLATES, "store-beauty")?.id).toBe("store-beauty");
    expect(matchTemplate(TEMPLATES, "modern store")?.id).toBe("ecommerce");
  });
  it("refuses an ambiguous or unknown name", () => {
    expect(matchTemplate(TEMPLATES, "blank")).toBeNull();
    expect(matchTemplate(TEMPLATES, "nope")).toBeNull();
  });
});

describe("labels and hints", () => {
  it("marks the starter kit and lists ids for --template", () => {
    expect(templateLabel(TEMPLATES[0])).toBe("Modern Store (store, starter kit)");
    expect(templateLabel(TEMPLATES[3])).toBe("Blank (website)");
    expect(templateHint(TEMPLATES.slice(0, 2))).toBe("pass --template <id>, one of: ecommerce (Modern Store), store-beauty (Beauty)");
  });
});

describe("resolveNameAndDir", () => {
  const cwd = path.resolve("/work");
  it("uses the folder for the name", () => {
    expect(resolveNameAndDir({ cwd, dir: "my-store", template: TEMPLATES[0] })).toEqual({ name: "my-store", dir: path.join(cwd, "my-store") });
  });
  it("derives the folder from --name, or the template's name", () => {
    expect(resolveNameAndDir({ cwd, name: "Glow Shop!", template: TEMPLATES[0] })).toEqual({ name: "Glow Shop!", dir: path.join(cwd, "glow-shop") });
    expect(resolveNameAndDir({ cwd, template: TEMPLATES[0] })).toEqual({ name: "Modern Store", dir: path.join(cwd, "modern-store") });
  });
  it("keeps --name and the folder apart when both are given", () => {
    expect(resolveNameAndDir({ cwd, dir: "shop", name: "My Shop", template: TEMPLATES[0] })).toEqual({ name: "My Shop", dir: path.join(cwd, "shop") });
  });
});

describe("API_PATHS.templates", () => {
  it("adds the type as a query parameter", () => {
    expect(API_PATHS.templates()).toBe("/api/cli/templates");
    expect(API_PATHS.templates("website")).toBe("/api/cli/templates?type=website");
  });
});

describe("describeCreateError", () => {
  it("adds the upgrade link to the plan rule", () => {
    const err = new ApiError("POST /api/cli/projects failed (403)", 403, {
      error: "plan_required",
      message: "Your plan does not allow creating a website",
      upgradeUrl: "https://nanosite.ai/backoffice/subscription",
    });
    expect(describeCreateError(err)).toBe("Your plan does not allow creating a website: upgrade at https://nanosite.ai/backoffice/subscription");
  });
  it("points a user at the limit to their options", () => {
    const err = new ApiError("x", 403, { error: "project_limit", message: 'Your plan includes 1 project. You already have "Old".' });
    expect(describeCreateError(err)).toMatch(/already have "Old"\. Upgrade your plan/);
  });
  it("falls back to the server message, then the HTTP summary", () => {
    expect(describeCreateError(new ApiError("x", 404, { error: "template_not_found", message: "Unknown template" }))).toBe("Unknown template");
    expect(describeCreateError(new ApiError("POST failed (500)", 500, null))).toBe("POST failed (500)");
  });
});

describe("nanodev open targets", () => {
  const config: DevConfig = { projectId: "p", name: "P", type: "store", gitUrl: "x", previewUrl: "https://p-preview/", webUrl: "https://app/edit" };
  it("parses the target (web by default)", () => {
    expect(parseOpenTarget(undefined)).toBe("web");
    expect(parseOpenTarget("Preview")).toBe("preview");
    expect(() => parseOpenTarget("admin")).toThrow(CliError);
  });
  it("picks the URL, or explains why there is none", () => {
    expect(urlForTarget(config, "web")).toBe("https://app/edit");
    // preview = your private preview from `nanodev preview`, never dev-config's always-present host.
    expect(() => urlForTarget(config, "preview")).toThrow(/run nanodev preview/);
    const preview = { status: "ready", sha: "abc", url: "https://p-draft/", servedSha: "abc", builtAt: null, pushedAt: "t" } as const;
    expect(urlForTarget(config, "preview", preview)).toBe("https://p-draft/");
    expect(() => urlForTarget(config, "live")).toThrow(/isn't published yet/);
    expect(() => urlForTarget({ ...config, webUrl: undefined }, "web")).toThrow(/doesn't report/);
  });
});

describe("after creating", () => {
  it("explains each warning", () => {
    expect(describeWarning("store_pending")).toMatch(/open the project once at nanosite\.ai/);
    expect(describeWarning("sandbox_pending")).toMatch(/nanodev link/);
  });
  it("blocks dev for a store without its backend, or when nothing is installed", () => {
    expect(devBlocker({ type: "store", warnings: ["store_pending"] }, true)).toMatch(/commerce backend/);
    expect(devBlocker({ type: "store", warnings: [] }, false)).toMatch(/aren't installed/);
    expect(devBlocker({ type: "website", warnings: ["store_pending"] }, true)).toBeNull();
    expect(devBlocker({ type: "store" }, true)).toBeNull();
  });
});
