import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviderLabel, parseGithubUrl, parseRepoUrl } from "../src/lib/repo-url.ts";

describe("parseRepoUrl", () => {
  it("parses GitHub URLs", () => {
    assert.deepEqual(parseRepoUrl("https://github.com/o/r"), {
      provider: "github",
      host: "github.com",
      projectPath: "o/r",
      repoName: "r",
    });
    assert.deepEqual(parseRepoUrl("https://github.com/o/r.git")?.repoName, "r");
    assert.equal(parseRepoUrl("https://github.com/o/r/tree/main")?.projectPath, "o/r");
  });

  it("parses GitLab URLs including nested groups", () => {
    assert.deepEqual(parseRepoUrl("https://gitlab.com/group/sub/project"), {
      provider: "gitlab",
      host: "gitlab.com",
      projectPath: "group/sub/project",
      repoName: "project",
    });
  });

  it("parses Bitbucket URLs", () => {
    assert.deepEqual(parseRepoUrl("https://bitbucket.org/workspace/repo"), {
      provider: "bitbucket",
      host: "bitbucket.org",
      projectPath: "workspace/repo",
      repoName: "repo",
    });
  });

  it("parses Codeberg URLs", () => {
    assert.deepEqual(parseRepoUrl("https://codeberg.org/owner/repo"), {
      provider: "codeberg",
      host: "codeberg.org",
      projectPath: "owner/repo",
      repoName: "repo",
    });
  });

  it("parses generic Gitea-compatible hosts", () => {
    assert.deepEqual(parseRepoUrl("https://git.example.com/owner/repo"), {
      provider: "gitea",
      host: "git.example.com",
      projectPath: "owner/repo",
      repoName: "repo",
    });
  });

  it("rejects invalid URLs", () => {
    assert.equal(parseRepoUrl("https://example.com"), null);
    assert.equal(parseRepoUrl("not-a-url"), null);
  });
});

describe("parseGithubUrl", () => {
  it("keeps GitHub-only compatibility", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/o/r"), { owner: "o", repo: "r" });
    assert.equal(parseGithubUrl("https://gitlab.com/o/r"), null);
  });
});

describe("getProviderLabel", () => {
  it("returns human-readable provider names", () => {
    assert.equal(getProviderLabel("github"), "GitHub");
    assert.equal(getProviderLabel("gitlab"), "GitLab");
  });
});
