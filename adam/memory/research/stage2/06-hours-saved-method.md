# 06 · Measuring "hours saved" credibly

Date: 2026-10-25. Scope: S2-04 (CEO dashboard). Constraint: numbers are computed deterministically, with evidence.
Tags: CONFIRMED = read in source (URL given) · INFERENCE = my reasoning · UNKNOWN = not found.

---

## Headline

- The market standard is **counted events × a fixed time assumption**: Zapier assumes 2 minutes per task, Microsoft assumes 6 minutes per Copilot search/summary or creation action, and UiPath uses admin-entered manual minutes per process × successful runs. All three label the result an estimate, and all three let the customer edit the assumption.
- Offload can do better than all three because Stage 1 **observes the manual baseline** for 7 days. Use the measured baseline, subtract measured human time that is still spent (review, approval, fixes), and count only successful runs. Show the evidence and a confidence grade on every number.

---

## 1. How others do it

| Product | Formula | Baseline source | Editable | Caveat language | Tag | Source |
|---|---|---|---|---|---|---|
| **Zapier** analytics ROI | tasks × **2 min** (task = successful action step) | Fixed default | Yes (ROI calculator) | "estimating" | CONFIRMED | https://help.zapier.com/hc/en-us/articles/25444544607373-Review-your-account-usage-in-the-analytics-dashboard |
| **Microsoft Copilot Dashboard** "Copilot assisted hours" (28 days) | Σ category: meeting hours summarised (actual duration, counted once) + search/summary actions × **6 min** + creation actions × **6 min**; value = hours × hourly rate (default **$72**, BLS) | Microsoft studies (163 and 147 knowledge workers) | Hourly rate/currency yes (not saved between sessions); multipliers no | "general estimate", "broad approximations", "methodology will evolve"; Cowork tasks matched to task types with research-based time impacts | CONFIRMED | https://learn.microsoft.com/en-us/viva/insights/org-team-insights/copilot-dashboard ; https://learn.microsoft.com/en-us/viva/insights/advanced/reference/metrics |
| **UiPath Insights** Business ROI | time saved = successful runs (jobs or queue items) × **manual time per process (min)** entered by admin; cost saved = time saved × hourly cost; Automation Hub "Time Savings Per Run" from an execution assessment | Admin input or Automation Hub assessment | Yes | — | CONFIRMED | https://docs.uipath.com/insights/automation-cloud/latest/user-guide/roi-customizations-and-calculations ; https://docs.uipath.com/insights/automation-cloud/latest/user-guide/business-roi-queues ; https://docs.uipath.com/insights/automation-cloud/latest/user-guide/automation-hub-roi-data-model ; https://docs.uipath.com/insights/standalone/2025.10/user-guide/templates |

Common weaknesses (INFERENCE): baselines are not measured per customer; residual human time (reviewing drafts, fixing errors) is ignored; "assisted" is conflated with "saved"; no per-number evidence.

## 2. Proposed Offload method (deterministic, evidence-linked)

For workflow *w* over period *P*:

```
baseline_w      = median observed manual duration of w's instances during the observation window
                  (active-time only: foreground time in the apps of that workflow, idle gaps > 2 min excluded)
residual_r      = measured human time on run r (time in the approval/review sheet + time editing the draft
                  + time on any manual fix-up flagged by the user)
saved_r         = max(0, baseline_w − residual_r)          for runs with outcome = success
saved_w,P       = Σ saved_r over successful runs r in P
hours_saved(scope) = Σ saved_w,P for workflows in scope (person / team / dept / company), only
                  aggregated at group size ≥ 5 for team/dept views (file 02)
```

Rules
1. **Only successful runs count.** Failed, cancelled or rejected runs contribute 0 and are shown separately. (UiPath counts successful jobs only. CONFIRMED.)
2. **Measured baseline beats assumed baseline.** Every workflow carries a `baseline_source`: `observed` (n instances, median, IQR), `user_estimate`, or `default`. The dashboard shows the share of hours from each source.
3. **Confidence grade** per workflow: A = observed with n ≥ 5 instances and IQR/median ≤ 0.5; B = observed with fewer instances or high spread; C = user estimate or default. CEO total shows "X h (A: a h, B: b h, C: c h)". INFERENCE (design).
4. **Residual time is subtracted**, not ignored. If a draft takes 3 minutes to review and the manual task took 10, the run saved 7.
5. **Overnight/cloud runs** use the same formula; residual is the morning review time.
6. **"Assisted" vs "saved"**: label anything without an observed baseline as "estimated", never as measured. Microsoft's own term is "assisted hours" for this reason. CONFIRMED (terminology).
7. **Money value** optional: hours × hourly rate set by the owner per department (default off; if on, show the rate). Microsoft and UiPath both expose this. CONFIRMED.
8. **Evidence drill-down**: every number links to the list of runs (id, timestamp, outcome, baseline used, residual seconds) and to the baseline sample (instance ids and durations, no screen content). Raw observation stays on the Mac; only instance durations and ids are uploaded (file 02 principle).
9. **Re-baselining**: baseline is frozen per workflow version; a new version can be re-observed only with the user's consent; history is never rewritten.
10. **No efficiency score per person by default.** "Efficiency gained" at person level is off unless the tenant enabled per-person views (file 02); team/dept show hours saved and adoption (active workflows, runs), not rankings.
11. **Reproducibility**: the dashboard number is a pure function of (runs table, baselines table, settings); store the computation version; a nightly job recomputes and must match. Fits the "numbers computed deterministically with evidence" rule.

## 3. What to show the CEO

- Hours saved this month (with A/B/C split), trend vs last month, by department.
- Adoption: people with ≥1 active workflow, workflows per department, runs per week.
- Top 10 workflows by hours saved (owner role, baseline source, confidence).
- Overnight share: hours saved by runs that happened outside the owner's working hours.
- Quality: run success rate, approval rejection rate, residual time trend (falling residual = trust rising).
- Caveat line on the page: how hours saved is computed, in one sentence, with a link to the method.

## TO CONFIRM
- TC1. Microsoft Cowork methodology PDF (task-type time impacts): https://microsoft.github.io/CopilotAnalyticsLabs/Cowork_Methodology.pdf
- TC2. Zapier ROI calculator editable fields.
- TC3. Whether Stage 1's observer records enough to compute active-time baselines (idle detection) without window titles.
