# CAPM Fellowship Final Exam — Remote Mastery Verification (RMV)

## Overview

Summative final examination for the Companion Animal Pain Management (CAPM) Fellowship. Follows the platform RMV structured interview format extended to all five blueprint domains.

## Format

| Property | Value |
|---|---|
| Exam type | RMV structured mastery interview |
| Sections | 5 (one per blueprint domain) |
| Phases per section | 4 (Concept Check → Applied Reasoning → Prioritization & Safety → Reflection & Transfer) |
| Primary prompts | 20 (4 × 5) |
| Max follow-ups | 2 per phase (max 40 follow-ups; 60 total prompts) |
| Estimated duration | 120–150 minutes |
| Pass threshold | ≥ 70% weighted score |

## Blueprint & Weighting

| # | Domain | Blueprint Weight |
|---|---|---|
| 1 | Techniques the Fellow is expected to know | 25.27% |
| 2 | Neuroanatomy, neuropharmacology, and neurophysiology | 14.40% |
| 3 | Pharmacology | 18.48% |
| 4 | Non-pharmacological approaches to pain management | 14.95% |
| 5 | Recognition, diagnosis, clinical metrology, and assessment of pain | 26.90% |
| | **Total** | **100.00%** |

## Scoring

Each section scored across six mastery domains (0–5 each, max 30 per section):

1. `core_concept_understanding`
2. `clinical_application`
3. `prioritization_decision_making`
4. `justification`
5. `boundaries_uncertainty`
6. `mastery_depth`

**Weighted final score** = Σ(section_pct × blueprint_weight), where section_pct = raw_score / 30.

| Outcome | Threshold |
|---|---|
| PASS | ≥ 70% weighted score |
| BORDERLINE — Human Review | 60–69% |
| FAIL — Remediation Required | < 60% |

## Source Corpus

Derived from all 95 CAPM fellowship transcripts:
`MADutton/CEHub-Mastery-Hub: orgs/abvp-aml-pilot/transcripts/`

- **Techniques:** Locoregional anesthesia series, epidural catheter placement (dog/cat/rabbit/ferret), nerve locator, ultrasound-guided injection, wound infusion catheters, acupuncture, electroacupuncture, PBM/laser therapy
- **Neuro:** Essays on veterinary neuroanatomy/neuropharmacology/neurophysiology (Dutton), avian and reptile neuroanatomy, opioid receptor binding, alpha-2 adrenoceptor physiology
- **Pharmacology:** Full opioid series, NSAID series, alpha-2 agonists, NMDA antagonists, corticosteroids, adjuncts, Epstein chronic med update 2024, Epstein other pain meds 1 & 2
- **Non-pharmacological:** Non-pharm series (dog/cat/bird/rabbit/ferret/guinea pig/rat/mouse/reptile), opioid-free multimodal series, PBM, acupuncture, FAS
- **Recognition/Assessment:** FAS, WASVA pain guidelines, Feline Pain, Epstein OA/high-sx/low-sx/neuropathic pain transcripts

## Files

| File | Description |
|---|---|
| `README.md` | This file |
| `exam_record.json` | Exam metadata |
| `exam_blueprint.json` | Blueprint with section weights and transcript references |
| `exam_objectives.json` | Consolidated learning objectives across all sections |
| `scoring_rubric.json` | Master scoring rubric with pass/borderline/fail thresholds |
| `interview_template.json` | Extended 5-section interview template |
| `examiner_system_prompt.txt` | Examiner conduct instructions |
| `prompts.json` | All 20 primary prompts + 40 planned follow-ups |
| `scoring_anchors.json` | Section-specific scoring anchors (6 domains × 5 sections) |
| `followup_rules.json` | Follow-up decision rules |
