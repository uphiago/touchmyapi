import { useState } from "react";
import type { AssessmentCreate, TargetCategory } from "../../../packages/contracts/src";

export const assessmentWizardSteps = [
  { key: "category", label: "Category" },
  { key: "target", label: "Target" },
  { key: "scope", label: "Scope" },
  { key: "limits", label: "Limits" },
  { key: "authorization", label: "Authorization" },
  { key: "review", label: "Review" },
] as const;

const categories: readonly TargetCategory[] = ["surface", "web", "api", "genai", "internal"];

export type AssessmentWizardProps = Readonly<{
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: AssessmentCreate) => void | Promise<void>;
}>;

export function AssessmentWizard({ open, busy, onClose, onCreate }: AssessmentWizardProps) {
  const [targetCategory, setTargetCategory] = useState<TargetCategory>("surface");
  const [target, setTarget] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [authorized, setAuthorized] = useState(false);
  if (!open) return null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authorized || target.trim() === "") return;
    const scope = scopeText
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    await onCreate({ targetCategory, target, scope, playbookId: "surface-public-posture" });
    setTarget("");
    setScopeText("");
    setAuthorized(false);
    onClose();
  }

  return (
    <dialog className="assessment-dialog" open aria-labelledby="assessment-dialog-title">
      <form className="wizard" onSubmit={submit}>
        <header className="wizard-header">
          <div>
            <span className="eyebrow">New authorized assessment</span>
            <h2 id="assessment-dialog-title">Define intent before queueing work.</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close assessment form"
          >
            ×
          </button>
        </header>
        <ol className="wizard-steps" aria-label="Assessment steps">
          {assessmentWizardSteps.map((step, index) => (
            <li key={step.key}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {step.label}
            </li>
          ))}
        </ol>
        <div className="wizard-grid">
          <section className="wizard-field">
            <span className="step-index">01 / Category</span>
            <label htmlFor="assessment-category">Assessment surface</label>
            <select
              id="assessment-category"
              className="field-control"
              value={targetCategory}
              onChange={(event) => setTargetCategory(event.currentTarget.value as TargetCategory)}
            >
              {categories.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </section>
          <section className="wizard-field">
            <span className="step-index">02 / Target</span>
            <label htmlFor="assessment-target">Authorized target</label>
            <input
              id="assessment-target"
              className="field-control"
              required
              maxLength={2048}
              placeholder="api.example.com"
              value={target}
              onChange={(event) => setTarget(event.currentTarget.value)}
            />
          </section>
          <section className="wizard-field wizard-field--wide">
            <span className="step-index">03 / Scope</span>
            <label htmlFor="assessment-scope">Allowed paths or hosts, one per line</label>
            <textarea
              id="assessment-scope"
              className="field-control field-control--textarea"
              placeholder="https://api.example.com/v1/"
              value={scopeText}
              onChange={(event) => setScopeText(event.currentTarget.value)}
            />
          </section>
          <section className="wizard-field">
            <span className="step-index">04 / Limits</span>
            <strong className="readonly-value">Passive · 1 concurrent · bounded duration</strong>
            <p>No network request is executed by this local draft flow.</p>
          </section>
          <section className="wizard-field">
            <span className="step-index">05 / Playbook</span>
            <strong className="readonly-value">surface-public-posture</strong>
            <p>Server-resolved safe default for this checkpoint.</p>
          </section>
          <section className="wizard-field wizard-field--wide authorization-check">
            <span className="step-index">06 / Authorization &amp; Review</span>
            <label>
              <input
                type="checkbox"
                checked={authorized}
                onChange={(event) => setAuthorized(event.currentTarget.checked)}
              />
              <span>
                <strong>I confirm that I am authorized</strong>
                <small>to assess this target and the scope declared above.</small>
              </span>
            </label>
          </section>
        </div>
        <footer className="wizard-footer">
          <p>Review creates a draft only. Queueing is a separate, explicit action.</p>
          <div>
            <button className="button button--ghost button--inline" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="button button--primary button--inline"
              type="submit"
              disabled={busy || !authorized || target.trim() === ""}
            >
              Save authorized draft
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
