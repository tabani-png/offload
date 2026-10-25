---
id: dpia
title: Data protection impact assessment (DPIA) for Offload
jurisdictions: [GB, DE, IE, FR, NL, ES, IT, CA-QC, CA-ON, CA-BC, CA-AB]
requiredFields: [organisation, assessor, dpo_advice, necessity, proportionality, risks, measures, residual_risk, sign_off_date]
---
> **Not legal advice; review by counsel before use.** Complete this before turning on per-person views or working-time
> views. Offload asks the owner to attest the date, document hash, signer name and title of the completed DPIA.

# DPIA: Offload in {{organisation}}

**Assessor:** {{assessor}}. **Sign-off date:** {{sign_off_date}}.

## 1. Description of the processing
- Mac: local activity capture, 7-day store, never uploaded.
- Control plane: automation run outcomes, review times, daily aggregates, optional working-time aggregates,
  workflows shared by employees. Hosted by Offload (processor).
- Features in scope (tick): [ ] per-person views [ ] working-time views.

## 2. Necessity
{{necessity}}

## 3. Proportionality
{{proportionality}}

## 4. Risks to workers
{{risks}}

Consider: pressure from per-person comparison, working-time use for pay or discipline, household members seen on
camera or screen for home workers (Offload does not upload screens), automated decisions.

## 5. Measures
{{measures}}

Built-in measures: group floor of 5 for any team total; no ranking of people; per-person and working-time views off by
default, owner-only enablement per jurisdiction with notice period; every per-person read audited and visible to the
employee; retention limits; purpose lock.

## 6. DPO advice
{{dpo_advice}}

## 7. Residual risk and decision
{{residual_risk}}

If high residual risk remains, consult the supervisory authority before starting.
