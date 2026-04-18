# RMV Assessment — Claude Code Context

## What this repo is

Content-only repository for RMV (Remote Mastery Verification) exam files. No application code — all runtime logic lives in `cehub-rmv-platform`. This repo stores the structured JSON and text files that define exams: prompts, scoring anchors, rubrics, blueprints, and metadata.

## Current contents

### CAPM Fellowship Final Exam (`capm_final_exam/`)

A 5-section standardized final exam for the Companion Animal Pain Management Fellowship. Built from all 95 fellowship transcripts.

```
capm_final_exam/
  exam_record.json          # Exam metadata, pass threshold (70%)
  exam_blueprint.json       # Blueprint weights + transcript mapping per section
  exam_objectives.json      # Learning objectives per section
  scoring_rubric.json       # 6-domain rubric, weighted scoring formula
  interview_template.json   # 4-phase session structure
  followup_rules.json       # Follow-up trigger rules
  examiner_system_prompt.txt
  README.md
  sections/
    01_techniques/           blueprint_weight: 25.27%
    02_neuro/                blueprint_weight: 14.40%
    03_pharmacology/         blueprint_weight: 18.48%
    04_non_pharm/            blueprint_weight: 14.95%
    05_recognition_assessment/ blueprint_weight: 26.90%
```

Each section directory contains:
- `prompts.json` — 4 primary prompts + 2 follow-ups each (pre-scripted, not AI-generated)
- `scoring_anchors.json` — high-value elements and major concerns per domain

## Exam format

- **Structure:** 5 sections × 4 phases (Concept Check → Applied Reasoning → Prioritization & Safety → Reflection & Transfer)
- **Scoring:** 6 domains (core_concept_understanding, clinical_application, prioritization_decision_making, justification, boundaries_uncertainty, mastery_depth), 0–5 scale each, max 30 per section
- **Weighted score:** section_pct × blueprint_weight; 70% weighted = pass, 60–69% = borderline, <60% = fail
- **Max prompts:** 60 (20 primary + up to 40 follow-ups)
- **Follow-up triggers:** vague_generic_answer, cannot_apply, missing_safety, unsupported_conclusion, misunderstands_objective

## Key fellowship content embedded in prompts

- Drug doses: amantadine 3–5 mg/kg q24h; ketamine CRI 60 mg/L at 5–10 mL/kg/hr; gabapentin CKD cats half-life 4h → 13–20h (IRIS Stage 3–4)
- Anti-NGF mAbs: Solensia (frunevetmab) for cats; Librela (bedinvetmab) for dogs
- Zoledronate: 0.1–0.5 mg/kg IV over exactly 15 min, normal saline only, max 4 mg, dental disease CI
- Pain scales with thresholds: FGS ≥4/10 (5 action units); UF EPS ≥4/12; Glasgow cats ≥5/20; Glasgow dogs ≥6/24
- EA frequencies: 2 Hz → enkephalin/beta-endorphin; 100 Hz → dynorphin
- PBM: cytochrome C oxidase target, 635–904 nm wavelength
- Cat LAST threshold ~47 mg/kg IV lidocaine vs dog ~80 mg/kg
- Tramadol: M1 metabolite via CYP2D6; dogs often deficient; cats effective at 2 mg/kg TID

## Platform integration

These files are consumed by `cehub-rmv-platform`. Each section runs as a separate mastery module session. Module IDs: `capm_final_01_techniques` through `capm_final_05_recognition_assessment`.

## Development conventions

- Feature branches: `claude/[feature-name]`
- All file changes go to feature branch first, then PR to main
- JSON files must be valid — validate before pushing
- Prompts use `followup_id` (not `prompt_id`) in followup objects to match platform expectations
- Scoring anchors use `anchors` key (not `domains`) to match platform loader

## Related repos

- `MADutton/cehub-rmv-platform` — the FastAPI application that runs these exams
- `MADutton/CEHub-Mastery-Hub` — source transcripts for the CAPM fellowship (95 .txt files in `orgs/abvp-aml-pilot/transcripts/`)
- `MADutton/assigned_case_rmv` — assigned case exam content (separate product type)
