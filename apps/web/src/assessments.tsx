import { useState } from "react";
import type { Assessment, AssessmentCreate, TargetCategory } from "../../../packages/contracts/src";

export type AssessmentsProps = Readonly<{
  assessments: readonly Assessment[];
  busy: boolean;
  onCreate: (input: AssessmentCreate) => void | Promise<void>;
  onQueue: (assessmentId: string) => void | Promise<void>;
}>;

const categories: readonly TargetCategory[] = ["web", "api", "surface", "genai", "internal"];

export function Assessments({ assessments, busy, onCreate, onQueue }: AssessmentsProps) {
  const [target, setTarget] = useState("");
  const [targetCategory, setTargetCategory] = useState<TargetCategory>("surface");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onCreate({ target, targetCategory, scope: [], playbookId: "surface-public-posture" });
    setTarget("");
  }

  return (
    <section className="panel panel--assessments" aria-labelledby="assessments-title">
      <div className="eyebrow">Assessment queue</div>
      <div className="panel__header">
        <div>
          <h2 id="assessments-title">Authorized assessments</h2>
          <p className="panel__hint">
            Create a draft, review the target, then queue it for the worker.
          </p>
        </div>
        <span className="badge">{assessments.length} assessments</span>
      </div>
      <form onSubmit={submit} className="form-grid form-grid--assessment">
        <div className="subpanel">
          <label className="field-label" htmlFor="assessment-target">
            Target
          </label>
          <input
            id="assessment-target"
            className="field-control"
            required
            maxLength={2048}
            placeholder="example.com"
            value={target}
            onChange={(event) => setTarget(event.currentTarget.value)}
          />
        </div>
        <div className="subpanel">
          <label className="field-label" htmlFor="assessment-category">
            Category
          </label>
          <select
            id="assessment-category"
            className="field-control"
            value={targetCategory}
            onChange={(event) => setTargetCategory(event.currentTarget.value as TargetCategory)}
          >
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || target.trim() === ""}
          >
            Save draft
          </button>
        </div>
      </form>
      {assessments.length === 0 ? (
        <p className="empty-state">No assessments yet. Start with an authorized target.</p>
      ) : (
        <ul className="member-list" aria-label="Assessments">
          {assessments.map((assessment) => (
            <li className="member-row" key={assessment.id}>
              <div>
                <strong>{assessment.target}</strong>
                <span className="member-meta">
                  {assessment.targetCategory} · {assessment.status}
                </span>
              </div>
              {assessment.status === "draft" ? (
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void onQueue(assessment.id)}
                >
                  Queue
                </button>
              ) : (
                <span className="badge badge--accent">{assessment.status}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
