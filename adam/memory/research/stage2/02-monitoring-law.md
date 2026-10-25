# 02 · Employee monitoring law and what it means for Offload's product

Date: 2026-10-25. Scope: S2-04 (dashboard), S2-09 (working-time insights), S2-10 (compliance pack).
Tags: CONFIRMED = read in source (URL given) · INFERENCE = my reasoning · UNKNOWN = not found.
**This is product research, not legal advice.** Each customer is the employer and the controller; Offload is the processor/service provider. Get a privacy lawyer in each launch market to review the compliance pack before selling there.

---

## Headline

- Every target jurisdiction treats Offload's Mac observer as **electronic monitoring** of employees, even though raw data stays on the device, because the employer deploys it and receives outputs about named people. INFERENCE from the definitions below (Ontario: "all forms of employee monitoring that is done electronically"; CT: "collection of information ... concerning employees' activities ... by any means other than direct observation"; ICO: "productivity tools which log how workers spend their time").
- Three tiers of risk, lowest to highest:
  1. **Workflow and outcome metrics** (automations run, approvals, estimated time saved per workflow). Notice + policy everywhere. Low risk.
  2. **Per-person productivity dashboard** ("efficiency by person"). This is profiling of work performance: Quebec s.8.1, California risk assessment, UK/EU DPIA, German works council. Medium-high risk.
  3. **"How much time they actually work"**. Highest risk; in the EU/UK it is close to the examples regulators list as high risk; in Germany it needs a works agreement. Keep it off by default (plan principle 6 is right), team-level aggregates only by default, never used for automated pay or dismissal decisions.

---

## (a) Canada

| # | Rule | Tag | Source |
|---|---|---|---|
| A1 | **Ontario ESA Part XI.1**: an employer with **25+ employees in Ontario on 1 January** must have a written electronic-monitoring policy **before 1 March** of that year. The policy states whether it monitors; if so, **how**, **in what circumstances**, **for what purposes** the information may be used, the date prepared and dates changed. Copy to employees within **30 days** (new hires within 30 days of starting; assignment employees within 24 h); keep each policy **3 years** after it ends. Covers personal devices used for work and work from home. It creates **no right not to be monitored** and no new privacy rights. | CONFIRMED | https://www.ontario.ca/document/your-guide-employment-standards-act-0/written-policy-electronic-monitoring-employees ; ESA s.15(8.2) https://www.ontario.ca/laws/statute/00e41 |
| A2 | **PIPEDA** covers employee information **only for federal works, undertakings or businesses** (banks, telecom, airlines, etc.). Provincially regulated Ontario employers have no general private-sector employee privacy statute (only the ESA policy rule). | CONFIRMED (PIPEDA scope) / INFERENCE (the Ontario gap) | https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/02_05_d_26/ |
| A3 | **OPC guidance**: monitoring limited to purposes that are "specific, targeted and appropriate"; least privacy-invasive measure; assess risks first (PIA recommended); retention rules; "Employers must make employees aware of the purpose, nature, extent and reasons for monitoring, as well as potential consequences"; access rights extend to monitoring data. | CONFIRMED | https://www.priv.gc.ca/en/privacy-topics/employers-and-employees/02_05_d_17/ |
| A4 | **FPT Commissioners' 2023 resolution**: reasonableness, necessity, proportionality; no AI-made significant employment decisions without a human in the loop; do PIAs and algorithmic impact assessments; tell employees how to object and challenge. | CONFIRMED | https://www.priv.gc.ca/en/about-the-opc/what-we-do/provincial-and-territorial-collaboration/joint-resolutions-with-provinces-and-territories/res_231005_02/ |
| A5 | **BC PIPA** (Alberta PIPA is similar): employee personal information may be collected **without consent** if reasonable for establishing, managing or terminating employment, **but the employer must notify the employee beforehand and say why**. Employers must have a privacy management program (purposes, access, retention, controls, complaints). | CONFIRMED (BC) / INFERENCE (Alberta parity, from OPC "substantially similar") | https://www.oipc.bc.ca/documents/guidance-documents/1371 ; https://oipc.bc.ca/documents/guidance-documents/1995 |
| A6 | **Quebec Law 25, private-sector Act s.8.1**: anyone collecting personal information with technology that can **identify, locate or profile** must **first inform** the person of the technology and of **the means to activate** those functions. "Profiling" explicitly includes analysing **work performance**. s.8.2: publish a plain-language confidentiality policy. | CONFIRMED | https://www.legisquebec.gouv.qc.ca/en/version/cs/p-39.1?code=se%3A8_1 ; OPC Q&A https://www.priv.gc.ca/en/privacy-and-transparency-at-the-opc/proactive-disclosure/opc-parl-bp/ethi_20240201/qa_20240201/?id=7777-6-625499 |
| A7 | Quebec s.9.1 (privacy by default: highest confidentiality setting by default) and s.3.3 (PIA for projects involving electronic information systems) are commonly read to mean profiling functions should be **off by default**. | INFERENCE (sections not read in this pass) | verify on LégisQuébec P-39.1 |

## (b) United States

| # | Rule | Tag | Source |
|---|---|---|---|
| B1 | **New York Civil Rights Law §52-c** (since 7 May 2022): employers monitoring phone, email or **internet access/usage** must give **prior written notice upon hiring**, **acknowledged** by the employee (in writing or electronically), and **post** the notice conspicuously. AG enforcement; $500 / $1,000 / $3,000 penalties. Exempts non-targeted system maintenance/protection. | CONFIRMED | https://www.nysenate.gov/legislation/laws/CVR/52-C%2A2 |
| B2 | **Connecticut §31-48d**: prior written notice of the **types** of monitoring to all affected employees, plus conspicuous posting (posting counts as notice). Amended effective **1 Oct 2026**: notice must also name the specific premises locations, and new hires from 1 Oct 2026 get a plain-language statement of prohibited activities that may be monitored without notice. Labor Commissioner penalties $500 / $1,000 / $3,000; no private right of action. | CONFIRMED | https://law.justia.com/codes/connecticut/title-31/chapter-557/section-31-48d/ ; amended text on CT DOL form DOL-100 rev. 10-1-2026 https://portal.ct.gov/dol/-/media/dol/2022-new-design-system/divisions/wage-and-workplace-standards/dol-100_4798.pdf |
| B3 | **Delaware 19 Del. C. §705**: no monitoring of phone, email or internet use unless the employer gives either an **electronic notice each day** the employee uses employer email/internet, or a **one-time notice acknowledged** in writing or electronically. $100 per violation. | CONFIRMED | https://law.justia.com/codes/delaware/title-19/chapter-7/subchapter-i/section-705/ |
| B4 | **California (CCPA as amended by CPRA)**: employee and HR data fully in scope since **1 Jan 2023**: notice at collection, privacy policy for HR individuals, service-provider contract terms, rights to know, delete, correct, limit sensitive PI. No private right of action except breaches. | CONFIRMED | https://www.littler.com/news-analysis/asap/finalization-regulations-clears-path-employers-complete-california-privacy |
| B5 | **CPPA regulations** (adopted 24 Jul 2025, effective 1 Jan 2026): a **risk assessment** is required **before** "automated processing" that analyses an employee's "performance at work" **based on systematic observation** of them as an employee; ADMT rules for **significant decisions** (employment, compensation, allocation of work) apply from **1 Jan 2027** (pre-use notice, opt-out or human appeal, access to logic). Some deadlines phase into 2027-2028. | CONFIRMED | https://cppa.ca.gov/faq.html ; https://www.goodwinlaw.com/en/insights/publications/2025/07/alerts-practices-dpc-californias-new-privacy-and-cybersecurity-regulations ; https://www.alston.com/en/insights/publications/2025/10/ccpa-cybersecurity-audits-admt-risk-assessments ; FSOR https://cppa.ca.gov/regulations/pdf/ccpa_updates_cyber_risk_admt_fsor_and_uid.pdf |
| B6 | A per-person "efficiency" or "hours actually worked" dashboard used by a manager to decide pay, work allocation or termination would likely be ADMT for a significant decision in California if it "substantially facilitates" the decision. A workflow-level "hours saved" metric is not. | INFERENCE | from B5 definitions |

## (c) United Kingdom

| # | Rule | Tag | Source |
|---|---|---|---|
| C1 | ICO guidance "Employment practices and data protection: monitoring workers" covers systematic monitoring incl. "productivity tools which log how workers spend their time" and keystroke logging. | CONFIRMED | https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/monitoring-workers/data-protection-and-monitoring-workers/ |
| C2 | Lawful basis required (one of six); special category condition if health etc. may be captured. | CONFIRMED | same |
| C3 | **DPIA must** be done before processing likely to be high risk; ICO high-risk examples include **keystroke monitoring** and **monitoring that may result in financial loss (performance management)**. DPO advice recorded. Workers informed before monitoring starts. Consider household members for home workers. Consult the ICO if high residual risk. ICO says do a DPIA even if not strictly high risk. | CONFIRMED | same |
| C4 | Solely automated decisions with legal or similarly significant effect (pay, dismissal) restricted under Art. 22; human reviewers must have authority and competence to override. | CONFIRMED | https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/monitoring-workers/what-do-we-need-to-do-if-we-use-monitoring-tools-that-use-solely-automated-processes/ |
| C5 | Commercially bought tools: employer is controller, vendor is processor; employer must get enough information from the vendor to do its DPIA, and a written contract. | CONFIRMED | https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/monitoring-workers/specific-data-protection-considerations-for-different-ways-or-methods-of-monitoring-workers |
| C6 | The guidance is "under review" after the Data (Use and Access) Act. | CONFIRMED | https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/monitoring-workers/ |

## (d) EU GDPR and Germany

| # | Rule | Tag | Source |
|---|---|---|---|
| D1 | Employee consent is rarely a valid basis because of the power imbalance; employers normally rely on legitimate interests or contract, with a balancing test. | INFERENCE from EDPB/WP29 position (Opinion 2/2017, consent guidelines 05/2020), confirmed in secondary literature | https://journals.sagepub.com/doi/pdf/10.1177/20319525251332923 |
| D2 | Germany: §26(2) BDSG says consent can be voluntary "in particular if the employee obtains a legal or economic advantage" or interests align. An employee who opts in to automations that save **them** time may fit this. | CONFIRMED (text quoted by BfDI) / INFERENCE (fit) | https://www.bfdi.bund.de/SharedDocs/Downloads/EN/Taetigkeitsberichte/33TB_24.pdf |
| D3 | **Works council co-determination, §87(1) no. 6 BetrVG**: introducing and using technical devices **objectively capable** of monitoring behaviour or performance needs works council agreement; actual intent to monitor is irrelevant. Courts applied it to Microsoft 365 (central admin access to logs) and commentators to M365 Copilot. Measures taken without it are invalid. The general works council is competent for company-wide single-tenant software. §90 BetrVG: inform and consult at the planning stage, even for a pilot. | CONFIRMED | https://www.advant-beiten.com/en/news/zustaendigkeit-des-gesamtbetriebsrats-bei-unternehmenseinheitlicher-nutzung-von-microsoft ; https://www.orrick.com/en/Insights/2024/09/AI-and-German-Co-Determination-What-Employers-Need-to-Know ; https://www.humanresourcesmanager.de/arbeitsrecht/microsoft-365-copilot-was-arbeitsrechtlich-zu-beachten-ist/ |
| D4 | Offload's admin dashboard is a central admin view over per-employee data, so it is squarely §87(1) no. 6 even if we only show aggregates. A German sale needs a template works agreement (Betriebsvereinbarung) in the compliance pack. | INFERENCE from D3 |
| D5 | **EU AI Act**: AI used to monitor and evaluate workers' performance and behaviour is Annex III high-risk. After the Digital Omnibus, Annex III obligations apply from **2 Dec 2027** (was 2 Aug 2026). Most transparency duties kept their dates. | CONFIRMED (dates) | https://ai-act-service-desk.ec.europa.eu/en/ai-act/timeline/timeline-implementation-eu-ai-act ; https://www.joneswalker.com/en/insights/blogs/ai-law-blog/yes-august-2-still-matters-the-eu-approved-a-high-risk-ai-delay-but-most-trans.html |
| D6 | Whether Offload's pattern miner (finding repeated work to automate, not evaluating the person) is "monitoring and evaluating performance" under Annex III. A per-person efficiency score likely is; a workflow suggestion engine shown only to the employee likely is not. Deployer duties (Art. 26) include informing workers' representatives before use. | INFERENCE / UNKNOWN (needs counsel) |

---

## Requirements matrix by feature

| Feature | Notice | Written policy | Opt-in | DPIA / PIA / risk assessment | Works council (DE) | Retention | Access rights |
|---|---|---|---|---|---|---|---|
| **Activity capture on the Mac** (local, 7-day, metadata allowlist) | Yes everywhere; NY needs acknowledgment at hire; DE (19 Del.C. §705) daily notice or acknowledged one-time; Quebec "first inform" + how to activate | Ontario 25+ employees; CT posted notice; BC/AB notification of purpose | Recommend employee-level opt-in for the observer, revocable; required in practice in Quebec for profiling functions (off by default) | Recommended everywhere; required UK/EU if high risk; CA risk assessment if analysing performance | Yes | 7-day raw store on device, auto-delete; employee can pause/delete | Employee sees everything the observer recorded, on their Mac |
| **Aggregated dashboards** (hours saved by workflow/team/department) | Yes | Include in policy (purpose: process improvement, not performance) | Not needed if only workflow-level and minimum group size enforced | Light DPIA; CA risk assessment unlikely if no per-person performance analysis | Likely yes (central admin over employee-derived data) | Aggregates kept; define period | Employee can see their own contribution |
| **Per-person efficiency** | Yes, specific | Yes, specific purposes | Recommend employee consent or at least prior notice + objection route | DPIA required (UK/EU, performance mgmt); CA risk assessment required; Quebec profiling rules | Yes, with explicit limits | Short | Full; plus explanation of calculation |
| **"Time actually worked"** | Yes, specific | Yes | Off by default; tenant admin enables per jurisdiction; employee notice period before start | DPIA mandatory in practice; CA risk assessment; ADMT rules from 2027 if used for pay/allocation | Yes, works agreement mandatory | Short | Full; correction right |

## Product requirements (concrete, for S2-04, S2-09, S2-10)

1. **Jurisdiction profile per employee** (province/state/country) set by the admin; features unavailable in a jurisdiction are hidden, not just warned.
2. **Notice engine**: in-app notice at first launch listing exactly what is captured, why, who sees what, retention, and how to pause; employee **acknowledgment recorded with timestamp and policy version** (NY, DE, CT). Delaware mode: optional daily banner.
3. **Policy generator** in the compliance pack: Ontario ESA policy fields (how, circumstances, purposes, date prepared, dates changed), CT posting text, NY notice text, BC/AB notification, Quebec s.8.1/8.2 text, CA notice at collection, UK/EU transparency notice. Version history kept 3+ years (Ontario).
4. **Privacy by default**: per-person views and working-time features **off by default**; turning them on requires the admin to tick a DPIA-done attestation and pick a jurisdiction-appropriate legal basis; Quebec and Germany require explicit enablement steps.
5. **Minimum group size** (e.g. 5) for any team/department aggregate so individuals cannot be singled out from a rollup.
6. **No raw data leaves the Mac** (plan principle 1). Upload only workflow definitions and computed metrics with their evidence references.
7. **Employee self-view**: everything the company sees about me, plus the evidence behind each number; export (access request) and delete/correct paths.
8. **Purpose lock**: metrics labelled "process improvement"; product terms prohibit using Offload outputs as the sole basis for pay, discipline or dismissal (Art. 22 UK/EU, CA ADMT 2027, FPT human-in-the-loop).
9. **DPIA template + data map + DPA** shipped in S2-10, including Managed Agents/Browserbase sub-processors and their retention (see file 01).
10. **Works agreement template (DE)** and a "works council mode" that limits admin views to what the agreement allows.
11. **Retention controls**: raw 7 days on device (fixed); per-person metrics default 90 days; aggregates default 24 months; all configurable downward only by default.
12. **Audit log** of every admin view of per-person data (who looked at whom, when).

## TO CONFIRM
- TC1. Quebec P-39.1 ss. 3.3 and 9.1 text, and CAI guidance on employee monitoring.
- TC2. Alberta PIPA ss. 15/18/21 employee-information wording.
- TC3. Whether the CT 2026 amendment's "specific locations" duty applies to remote software monitoring.
- TC4. AI Act Art. 26(7) wording after the Omnibus.
- TC5. A lawyer's read on whether the pattern miner is Annex III.
