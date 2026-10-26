# BLUE Evidence 0.3.3

Adds scan JSON-schema limits before the model call: summary <=2500 characters,
at most four evidence items, quote <=600 and relation <=1500. Oversized responses
fail with scan_contract_failed and remain intact in private audits; summaries
are never silently shortened. This addresses the observed H1 summary overflow
structurally. One fixed service-path calibration completed; H1-specific completion,
repeat stability and scientific gold remain unestablished.

Reuses the immutable 0.3.1 pipeline. Only scan evidence quotes may be rebound
to a unique whitespace-equivalent span in that model call's delivered segment.
Runtime preserves case, numbers, punctuation and every hyphen/sign. The offline
helper also supports letter-hyphen-linebreak-letter aliases, but runtime rejects
those because a line-end hyphen may be a mathematical operator.

Raw responses stay unchanged in private modelCalls audit entries. Derived
responses, source offsets and response hashes are recorded separately. Rejected
evidence fails; it is never silently dropped. Existing exact source validation
still applies. Selection anchors, final expert/challenge findings and external
quotations are not rewritten. This is source binding, not scientific validation.

```powershell
python -m unittest discover -s app/examples/evidence_blue_v033 -p "test_*.py" -q
python app/examples/evidence_blue_v033/build_profile.py
```

The profile contains PC-specific paths and uses the existing logged-in Claude
subscription. A profile alone does not install its runner on another PC. Offline
tests imply no web registration, live trial, release or deployment. Previous
version profiles and experiment records stay intact.

Per-PC installation and call-budget details: [BLUE setup](../../../docs/blue-evidence.md).
