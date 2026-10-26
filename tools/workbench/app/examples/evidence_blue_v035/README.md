# BLUE Evidence v0.3.5 timeout hotfix

Reuses v0.3.4 strategy and validation without modifying predecessor runners.
Document-stage calls allow up to 120 seconds (previously70); other stages70.
Total invocation150 seconds, four internal calls maximum, same Claude subscription,
same model/effort, no retries or automatic model substitution.

Timeout remains a failure, never abstention or successful detection. Runner exits124;
the updated local adapter maps this reserved exit code to a fixed timeout message.
Other nonzero exits retain the generic error, without logging stdout/stderr secrets.

After installing source, run `python app/examples/evidence_blue_v035/build_profile.py`
using the companion virtualenv, import generated profile.json and select v0.3.5.
Generated profiles/audits are local and must not be committed. Old profile files and
records are preserved; frozen bundle definitions are never silently rewritten.
Real model success after this change has not been validated; tests are offline.
