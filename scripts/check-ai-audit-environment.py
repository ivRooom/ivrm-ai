#!/usr/bin/env python3
"""Advisory, offline validation of live GitHub aws-ai-audit environment JSON.

Fetch read-only GET API responses separately using a trusted operator session.
This validator never contacts GitHub/AWS, never exposes reviewers, and never
authorizes IAM Apply, GitHub OIDC or production release.
"""
import argparse
import json
from pathlib import Path
import sys

ENVIRONMENT = "aws-ai-audit"


def evaluate(environment, branch_policies):
    errors = []
    result = {
        "environment": ENVIRONMENT,
        "configuration": "NO_GO",
        "branch_scope": "UNVERIFIED",
        "independent_review": "UNVERIFIED",
        "human_confirmation": "REQUIRED",
        "aws_role_and_trust": "NOT_VERIFIED",
    }
    if not isinstance(environment, dict) or environment.get("name") != ENVIRONMENT:
        return ["missing_or_wrong_environment"], result
    policy = environment.get("deployment_branch_policy")
    if not isinstance(policy, dict) or policy.get("custom_branch_policies") is not True or policy.get("protected_branches") is not False:
        errors.append("must_use_custom_branch_policy")
    if not isinstance(branch_policies, dict) or not isinstance(branch_policies.get("branch_policies"), list):
        errors.append("missing_branch_policy_api_response")
    else:
        policies = branch_policies["branch_policies"]
        if len(policies) != 1 or not isinstance(policies[0], dict) or policies[0].get("name") != "main" or policies[0].get("type") != "branch":
            errors.append("deployment_branch_must_be_exact_main_only")
        else:
            result["branch_scope"] = "MAIN_ONLY"
        if branch_policies.get("total_count") != 1:
            # A partial API page must never be mistaken for an exhaustive read.
            errors.append("incomplete_or_unexpected_branch_policy_count")
    rules = environment.get("protection_rules")
    reviewer = None
    if not isinstance(rules, list):
        errors.append("missing_protection_rules")
    else:
        matches = [x for x in rules if isinstance(x, dict) and x.get("type") == "required_reviewers"]
        if len(matches) != 1:
            errors.append("independent_reviewer_gate_missing")
        else:
            reviewer = matches[0]
    if reviewer is not None:
        listed = reviewer.get("reviewers")
        if not isinstance(listed, list) or not listed:
            errors.append("no_required_reviewer")
        if reviewer.get("prevent_self_review") is not True:
            errors.append("self_review_not_blocked")
        if not any(x.get("type") in ("User", "Team") and isinstance(x.get("reviewer"), dict) for x in listed or [] if isinstance(x, dict)):
            errors.append("reviewer_configuration_invalid")
        if not errors or not any(x.startswith(("independent_reviewer", "no_required_reviewer", "self_review", "reviewer_configuration")) for x in errors):
            result["independent_review"] = "PROTECTED"
    if environment.get("can_admins_bypass") is not False:
        errors.append("administrators_can_bypass_or_state_not_verifiable")
    if environment.get("wait_timer", 0) not in (0, None):
        # Wait timers are not a substitute for a reviewer; leave them enabled
        # if configured, but do not infer any automatic approval.
        pass
    if not errors:
        result["configuration"] = "ADVISORY_READY_NOT_RELEASE"
    return errors, result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--environment-json", required=True)
    p.add_argument("--branch-policies-json", required=True)
    args = p.parse_args()
    try:
        env = json.loads(Path(args.environment_json).read_text(encoding="utf-8-sig"))
        branches = json.loads(Path(args.branch_policies_json).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        print('{"configuration":"NO_GO","errors":["missing_or_unreadable_json"]}')
        return 2
    errors, result = evaluate(env, branches)
    result["errors"] = errors
    print(json.dumps(result, sort_keys=True))
    return 0 if not errors else 2


if __name__ == "__main__":
    sys.exit(main())
