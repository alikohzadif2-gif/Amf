# meYou — how to start a phase (Claude writes the project; Replit is not used)

Upload `meyou-src.zip` to a new chat with Claude, then paste ONE of these.

## Start a phase
```
Project meYou (React Native + Expo, Android-only). Source attached.
Read docs/HANDOFF.md, then docs/PROJECT_BRIEF.md (incl. hard rule 12 and the Decisions log), docs/API_CONTRACT.md, docs/PHASES.md.
Do ONLY Phase {N}.
HARD RULE: do NOT invent. First web-search for an existing tool/package that already does the job; choose the simplest, smallest, most popular one; write only thin glue code. If nothing fits, stop and ask me before writing a custom engine. Name the chosen tool in HANDOFF.
Also: do not rewrite finished code, delete cut features instead of badging them, run typecheck + tests when dependencies can be installed.
At the end: update HANDOFF, tick the phase, append decisions, give me meyou-src.zip and a 5-line summary. Then stop.
```

## Fix a bug
```
Read docs/HANDOFF.md. Fix only this bug with the fewest file changes: <error text / what you see>. No refactor, no new features, no custom code if a library already solves it. Give me the updated meyou-src.zip.
```

## Build the APK (Phase 10 only)
```
Do Phase 10. Use EAS Build (or GitHub Actions). Give me the exact files and commands; I will run the build myself.
```

## Start a refinement phase (R1a … R11, plan in docs/REFINE_PHASES.md)
```
Project meYou (React Native + Expo, Android-only). Source attached.
Read docs/HANDOFF.md (short), docs/REFINE_PHASES.md (incl. "Findings" and your phase), docs/API_CONTRACT.md only if you touch the protocol. Do not read docs/HANDOFF_ARCHIVE.md unless needed.
Do ONLY phase R{N}. Follow its items; do not touch other phases' items. Open only the files in its "Touches".
Rules: PROMPTS.md HARD RULE (search for an existing tool before custom code), extend finished code, fa + en parity, typecheck + tests, no custom engines.
End: tick R{N}, add at most 3 lines to HANDOFF Status, give meyou-src.zip and a 5-line summary, say whether a VPS update or a new APK is needed. Then stop.
```
Replace `{N}` with the phase id: R1a, R1b, R2, R3, R4, R5a, R5b, R6, R7, R8a, R8b, R9, R10a, R10b, R10c, R11. Only R1a needs `sudo ./setup.sh update` on the VPS; all others need only a new APK. Do them in this order.

## Start a round-2 phase (Q1 … Q9, plan in docs/ROUND2_PHASES.md)
```
Project meYou (React Native + Expo, Android-only). Source attached.
Read docs/HANDOFF.md (short), docs/ROUND2_PHASES.md (incl. "Findings" and your phase), docs/API_CONTRACT.md only if you touch the protocol. Do not read docs/HANDOFF_ARCHIVE.md unless needed.
Do ONLY phase Q{N}. Follow its items; do not touch other phases' items. Find files with grep; open only what the phase needs.
Rules: PROMPTS.md HARD RULE (search for an existing tool before custom code), extend finished code, fa + en parity, typecheck + tests, no custom engines.
End: tick Q{N}, add at most 3 lines to HANDOFF Status, give meyou-src.zip and a 5-line summary, say whether a VPS update or a new APK is needed. Then stop.
```
Order: Q1, Q2, Q6, Q3, Q4, Q5, Q7, Q8a, Q8b, Q8c, Q9 (ids: Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8a, Q8b, Q8c, Q9). All need only a new APK unless Q1 finds the VPS is old.

