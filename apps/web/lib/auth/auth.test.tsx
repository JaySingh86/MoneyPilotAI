// `POST /me/bootstrap` runs after sign-in and after every token refresh (ADR-017, WP-17), and the
// first-name prompt appears when the API asks for it.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { API_BASE_URL } from "../config";
import { server } from "../../test/server";
import { renderApp } from "../../test/render";
import { state } from "../../mocks/state";
import { FirstNameForm } from "../components/FirstNameForm";
import { useAuth } from "./AuthProvider";

function Probe() {
  const { status, me, signOut } = useAuth();
  return (
    <div>
      <p>status:{status}</p>
      <p>me:{me?.firstName ?? "none"}</p>
      <button onClick={() => void signOut()}>out</button>
      <FirstNameForm />
    </div>
  );
}

describe("auth provider", () => {
  it("bootstraps the user once when a session exists", async () => {
    renderApp(<Probe />);
    await screen.findByText("status:signed_in");
    expect(screen.getByText("me:Sam")).toBeTruthy();
    expect(state.bootstrapCalls).toBe(1);
  });

  it("bootstraps again after each token refresh", async () => {
    const { adapter } = renderApp(<Probe />);
    await screen.findByText("status:signed_in");
    adapter.simulateTokenRefresh();
    await waitFor(() => expect(state.bootstrapCalls).toBe(2));
    adapter.simulateTokenRefresh();
    await waitFor(() => expect(state.bootstrapCalls).toBe(3));
  });

  it("bootstraps after a sign-in", async () => {
    const { adapter } = renderApp(<Probe />, { signedIn: false });
    await screen.findByText("status:signed_out");
    expect(state.bootstrapCalls).toBe(0);
    await adapter.signIn("sam@rivera-household.example", "pw");
    await screen.findByText("status:signed_in");
    expect(state.bootstrapCalls).toBe(1);
  });

  it("sends the bearer token on API calls", async () => {
    let authorization: string | null = null;
    server.use(
      http.post(`${API_BASE_URL}/v1/me/bootstrap`, ({ request }) => {
        authorization = request.headers.get("authorization");
        return HttpResponse.json({ id: "x" }, { status: 200 });
      }),
    );
    renderApp(<Probe />);
    await waitFor(() => expect(authorization).toBe("Bearer mock-access-token"));
  });

  it("asks for a first name when the API says it is missing, then retries with it", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${API_BASE_URL}/v1/me/bootstrap`, async ({ request }) => {
        const body = (await request.json()) as { firstName?: string };
        bodies.push(body);
        if (body.firstName === "Sam")
          return HttpResponse.json({ id: "x", firstName: "Sam", memberships: [] });
        return HttpResponse.json(
          { type: "/problems/validation_failed", title: "x", status: 400, code: "validation_failed" },
          { status: 400, headers: { "content-type": "application/problem+json" } },
        );
      }),
    );
    // A session without a name in the token, as a federated sign-in can be.
    const { adapter } = renderApp(<Probe />, { signedIn: true });
    await screen.findByText("status:signed_in"); // the first call carries Sam's name from the token
    const original = adapter.getSession.bind(adapter);
    adapter.getSession = async () => {
      const s = await original();
      return s && { ...s, firstName: null };
    };
    adapter.simulateTokenRefresh();
    await screen.findByText("status:needs_name");
    await userEvent.type(screen.getByLabelText("First name"), "Sam");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("status:signed_in");
    expect(bodies.at(-1)).toMatchObject({ firstName: "Sam" });
  });

  it("signs out", async () => {
    renderApp(<Probe />);
    await screen.findByText("status:signed_in");
    await userEvent.click(screen.getByRole("button", { name: "out" }));
    await screen.findByText("status:signed_out");
  });
});
