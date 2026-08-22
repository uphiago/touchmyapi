import { useEffect, useState } from "react";
import { healthResponseSchema } from "@touchmyapi/contracts";

type ApiStatus = "checking" | "online" | "unavailable";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

export default function App() {
  const [status, setStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const response = await fetch(`${API_BASE_URL}/health`);
        if (!response.ok) {
          if (!cancelled) setStatus("unavailable");
          return;
        }
        const parsed = healthResponseSchema.safeParse(await response.json());
        if (!cancelled) setStatus(parsed.success ? "online" : "unavailable");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    }

    void checkHealth();

    return () => {
      cancelled = true;
    };
  }, []);

  const statusLabel =
    status === "checking"
      ? "Checking API…"
      : status === "online"
        ? "API online"
        : "API indisponível";

  return (
    <main className="shell">
      <h1>TouchMyAPI</h1>
      <p className="tagline">Authorized security assessments.</p>
      <a href={`${API_BASE_URL}/health`} target="_blank" rel="noreferrer">
        Check API health
      </a>
      <p className={`status status--${status}`}>{statusLabel}</p>
    </main>
  );
}
