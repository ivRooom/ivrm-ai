import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("audit_env",ROOT/"scripts/check-ai-audit-environment.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def valid():
    return {
        "name":"aws-ai-audit",
        "deployment_branch_policy":{"protected_branches":False,"custom_branch_policies":True},
        "protection_rules":[],
        "can_admins_bypass":False,
    }, {"total_count":1,"branch_policies":[{"name":"main","type":"branch"}]}


class AuditEnvironmentGateTests(unittest.TestCase):
    def test_verified_config_still_never_grants_aws_release(self):
        e,b=valid()
        errors,report=mod.evaluate(e,b)
        self.assertEqual(errors,[])
        self.assertEqual(report["configuration"],"ADVISORY_READY_NOT_RELEASE")
        self.assertEqual(report["aws_role_and_trust"],"NOT_VERIFIED")
        self.assertEqual(report["human_confirmation"],"REQUIRED")

    def test_unknown_or_wrong_environment_denied(self):
        e,b=valid()
        self.assertTrue(mod.evaluate({},b)[0])
        e["name"]="aws-runtime"
        self.assertTrue(mod.evaluate(e,b)[0])

    def test_reject_unrestricted_or_protected_branches_instead_exact_main(self):
        for p in (None,{},{"protected_branches":True,"custom_branch_policies":False}):
            e,b=valid()
            e["deployment_branch_policy"]=p
            self.assertIn("must_use_custom_branch_policy",mod.evaluate(e,b)[0])

    def test_reject_branch_wildcards_tags_and_multiple_policies(self):
        for pol in ([{"name":"main*","type":"branch"}],[{"name":"main","type":"tag"}],
                    [{"name":"main","type":"branch"},{"name":"release/*","type":"branch"}],[]):
            e,b=valid()
            b["branch_policies"]=pol
            b["total_count"]=len(pol)
            self.assertIn("deployment_branch_must_be_exact_main_only",mod.evaluate(e,b)[0])

    def test_reject_partial_pagination(self):
        e,b=valid()
        b["total_count"]=2
        self.assertIn("incomplete_or_unexpected_branch_policy_count",mod.evaluate(e,b)[0])

    def test_solo_mode_does_not_claim_independent_review(self):
        e,b=valid()
        errors,report=mod.evaluate(e,b)
        self.assertEqual(errors,[])
        self.assertEqual(report["independent_review"],"NOT_CONFIGURED_SOLO")
        self.assertEqual(report["aws_role_and_trust"],"NOT_VERIFIED")

    def test_valid_optional_real_reviewer_mode(self):
        e,b=valid()
        e["protection_rules"]=[{"type":"required_reviewers","prevent_self_review":True,
            "reviewers":[{"type":"User","reviewer":{"id":123,"login":"reviewer"}}]}]
        errors,report=mod.evaluate(e,b)
        self.assertEqual(errors,[])
        self.assertEqual(report["independent_review"],"PROTECTED")

    def test_reject_misconfigured_optional_reviewer(self):
        for rules in ([{"type":"required_reviewers","reviewers":[],
                                                         "prevent_self_review":True}],
                      [{"type":"required_reviewers","reviewers":[{"type":"User","reviewer":{"id":1}}],
                        "prevent_self_review":False}],
                      [{"type":"required_reviewers","reviewers":[{"type":"User","reviewer":{"id":1}}],
                        "prevent_self_review":True}]*2):
            e,b=valid()
            e["protection_rules"]=rules
            self.assertTrue(mod.evaluate(e,b)[0])

    def test_reject_admin_bypass_even_with_review(self):
        for bypass in (True,None):
            e,b=valid()
            e["can_admins_bypass"]=bypass
            self.assertIn("administrators_can_bypass_or_state_not_verifiable",mod.evaluate(e,b)[0])

    def test_reject_wrong_schema(self):
        e,b=valid()
        self.assertTrue(mod.evaluate(e,[])[0])
        e["protection_rules"]=None
        self.assertTrue(mod.evaluate(e,b)[0])

    def test_only_sanitized_results_no_reviewer_user_data(self):
        e,b=valid()
        _,result=mod.evaluate(e,b)
        self.assertNotIn("reviewer",str(result).replace("independent_review",""))
        self.assertNotIn("123",str(result))


if __name__=="__main__":
    unittest.main()
