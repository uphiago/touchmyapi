import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingPage } from "./landing";

describe("public landing and authentication entry", () => {
  it("explains the authorized workflow and offers configured GitHub login", () => {
    const markup = renderToStaticMarkup(
      <LandingPage
        status="online"
        providers={[{ id: "github", label: "GitHub" }]}
        busy={false}
        error={null}
        onGitHub={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(markup).toContain("Continue with GitHub");
    expect(markup).toContain("Authorization recorded");
    expect(markup).toContain("Policy decides");
    expect(markup).toContain("PostgreSQL queues");
    expect(markup).toContain("AI never executes");
    expect(markup).not.toContain("Workspace unavailable");
  });

  it("shows an honest provider setup state when the API has no OAuth app", () => {
    const markup = renderToStaticMarkup(
      <LandingPage
        status="online"
        providers={[]}
        busy={false}
        error={null}
        onGitHub={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(markup).toContain("GitHub sign-in is not configured yet");
    expect(markup).toContain("API online");
    expect(markup).not.toContain("Continue with GitHub");
  });
});
